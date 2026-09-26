//! Disposable public-key regtest fixtures. Never accepts a remote RPC or wallet secrets.
use anyhow::{bail, ensure, Context, Result};
use ripemd::Ripemd160;
use secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command, time::Duration};
use zcash_primitives::transaction::{
    sighash::{signature_hash, SignableInput},
    txid::TxIdDigester,
    Authorization, Authorized, Transaction, TransactionData, TxVersion,
};
use zcash_protocol::{
    consensus::{BranchId, NetworkType},
    value::Zatoshis,
};
use zcash_transparent::{
    address::{Script, TransparentAddress},
    bundle::{self, Bundle, OutPoint, TxIn, TxOut},
    sighash::{SighashType, TransparentAuthorizingContext},
};

const GENESIS: &str = "029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327";
const FEE: u64 = 30_000;
const PRICE: u64 = 100_000_000;
const LOT: u128 = 1_000_000_000_000_000_001;
const NAME: &str = "REGTESTATOMICLOT";
const EXPIRY: u32 = 500;
const SELLER: u8 = 41;
const BUYER: u8 = 42;
const MINER: u8 = 43;

fn secret(role: u8) -> SecretKey {
    SecretKey::from_slice(&[role; 32]).unwrap()
}
fn public(role: u8) -> PublicKey {
    // Public constants keep the coordinator path from instantiating secret keys.
    let hex = match role {
        SELLER => "035c4e0dec7215e26833938730e5e505aa62504da85ba57106a46b5a2404fc9d8e",
        BUYER => "035be5e9478209674a96e60f1f037f6176540fd001fa1d64694770c56a7709c42c",
        MINER => "02bb58b5feca505c74edc000d8282fc556e51a1024fc8e7d7e56c6f887c5c8d5f2",
        _ => panic!("unknown fixture role"),
    };
    PublicKey::from_slice(&hex::decode(hex).unwrap()).unwrap()
}
fn address(role: u8) -> TransparentAddress {
    TransparentAddress::from_pubkey(&public(role))
}
fn script(bytes: Vec<u8>) -> Script {
    Script(zcash_script::script::Code(bytes))
}
fn role_script(role: u8) -> String {
    hex::encode(Script::from(address(role).script()).0 .0)
}
fn mining_address() -> String {
    address(MINER)
        .to_zcash_address(NetworkType::Regtest)
        .to_string()
}
fn name_value(name: &str) -> u128 {
    name.bytes().enumerate().fold(0, |n, (i, b)| {
        (n + u128::from(i > 0)) * 26 + u128::from(b - b'A')
    })
}
fn push(bytes: &[u8]) -> Vec<u8> {
    assert!(bytes.len() <= 79);
    let mut out = if bytes.len() <= 75 {
        vec![bytes.len() as u8]
    } else {
        vec![0x4c, bytes.len() as u8]
    };
    out.extend(bytes);
    out
}
fn carrier(values: &[u128]) -> String {
    let mut payload = vec![];
    for value in values {
        let mut n = *value;
        loop {
            let b = (n & 127) as u8;
            n >>= 7;
            payload.push(b | if n > 0 { 128 } else { 0 });
            if n == 0 {
                break;
            }
        }
    }
    assert!(payload.len() <= 79);
    let mut out = vec![0x6a, 0x5e];
    out.extend(push(&payload));
    hex::encode(out)
}
fn etch_script() -> String {
    carrier(&[2, 1, 4, name_value(NAME), 12, LOT, 22, 0])
}
fn transfer_script(height: u32, index: u32, output: u32) -> String {
    carrier(&[0, height.into(), index.into(), 0, output.into()])
}
fn redeem_script() -> Vec<u8> {
    let mut preimage = b"ZRN1-ETCH".to_vec();
    preimage.extend(name_value(NAME).to_le_bytes());
    let mut redeem = push(&Sha256::digest(preimage));
    redeem.push(0x75);
    redeem.extend(push(&public(SELLER).serialize()));
    redeem.push(0xac);
    redeem
}
fn commitment_script() -> String {
    let hash = Ripemd160::digest(Sha256::digest(redeem_script()));
    let mut out = vec![0xa9, 0x14];
    out.extend(hash);
    out.push(0x87);
    hex::encode(out)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Coin {
    txid: String,
    vout: u32,
    value_zat: u64,
    script: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Output {
    value_zat: u64,
    script: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    inputs: Vec<Coin>,
    outputs: Vec<Output>,
    expiry: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    asset: Coin,
    funding: Coin,
    etch_txid: String,
    ancestors: Vec<String>,
    price_zat: u64,
    fee_zat: u64,
    quantity: String,
    rune_height: u32,
    rune_index: u32,
    expiry: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SellerSignature {
    script_sig: String,
    digest: String,
}

#[derive(Debug, Clone)]
struct ContextAuth(Vec<TxOut>);
impl bundle::Authorization for ContextAuth {
    type ScriptSig = Script;
}
impl TransparentAuthorizingContext for ContextAuth {
    fn input_amounts(&self) -> Vec<Zatoshis> {
        self.0.iter().map(TxOut::value).collect()
    }
    fn input_scriptpubkeys(&self) -> Vec<Script> {
        self.0.iter().map(|c| c.script_pubkey().clone()).collect()
    }
}
struct TxContext;
impl Authorization for TxContext {
    type TransparentAuth = ContextAuth;
    type SaplingAuth = <Authorized as Authorization>::SaplingAuth;
    type OrchardAuth = <Authorized as Authorization>::OrchardAuth;
}
fn outpoint(coin: &Coin) -> Result<OutPoint> {
    let mut bytes = hex::decode(&coin.txid)?;
    ensure!(bytes.len() == 32, "txid length");
    bytes.reverse();
    Ok(OutPoint::new(bytes.try_into().unwrap(), coin.vout))
}
fn txout(out: &Output) -> Result<TxOut> {
    Ok(TxOut::new(
        Zatoshis::from_u64(out.value_zat)?,
        script(hex::decode(&out.script)?),
    ))
}
fn coin_txout(coin: &Coin) -> Result<TxOut> {
    txout(&Output {
        value_zat: coin.value_zat,
        script: coin.script.clone(),
    })
}
fn context(p: &Proposal) -> Result<TransactionData<TxContext>> {
    Ok(TransactionData::from_parts(
        TxVersion::V5,
        BranchId::Nu6_3,
        0,
        p.expiry.into(),
        Some(Bundle {
            vin: p
                .inputs
                .iter()
                .map(|c| Ok(TxIn::from_parts(outpoint(c)?, Script::default(), u32::MAX)))
                .collect::<Result<_>>()?,
            vout: p.outputs.iter().map(txout).collect::<Result<_>>()?,
            authorization: ContextAuth(p.inputs.iter().map(coin_txout).collect::<Result<_>>()?),
        }),
        None,
        None,
        None,
    ))
}
fn sighash(p: &Proposal, index: usize, mode: SighashType) -> Result<[u8; 32]> {
    let tx = context(p)?;
    let coin = coin_txout(&p.inputs[index])?;
    let input = zcash_transparent::sighash::SignableInput::from_parts(
        tx.transparent_bundle().unwrap(),
        mode,
        index,
        coin.script_pubkey(),
        coin.script_pubkey(),
        coin.value(),
    )?;
    Ok(*signature_hash(
        &tx,
        &SignableInput::Transparent(input),
        &tx.digest(TxIdDigester),
    )
    .as_ref())
}
fn sign(
    p: &Proposal,
    index: usize,
    role: u8,
    mode: SighashType,
    redeem: Option<&[u8]>,
) -> Result<String> {
    let sig = Secp256k1::new().sign_ecdsa(
        &Message::from_digest(sighash(p, index, mode)?),
        &secret(role),
    );
    let mut bytes = sig.serialize_der().to_vec();
    bytes.push(mode.encode());
    let mut result = push(&bytes);
    result.extend(push(redeem.unwrap_or(&public(role).serialize())));
    Ok(hex::encode(result))
}
fn assemble(p: &Proposal, signatures: &[String]) -> Result<Transaction> {
    ensure!(p.inputs.len() == signatures.len(), "signature count");
    TransactionData::<Authorized>::from_parts(
        TxVersion::V5,
        BranchId::Nu6_3,
        0,
        p.expiry.into(),
        Some(Bundle {
            vin: p
                .inputs
                .iter()
                .zip(signatures)
                .map(|(c, s)| {
                    Ok(TxIn::from_parts(
                        outpoint(c)?,
                        script(hex::decode(s)?),
                        u32::MAX,
                    ))
                })
                .collect::<Result<_>>()?,
            vout: p.outputs.iter().map(txout).collect::<Result<_>>()?,
            authorization: bundle::Authorized,
        }),
        None,
        None,
        None,
    )
    .freeze()
    .map_err(Into::into)
}
fn encode(tx: &Transaction) -> Result<String> {
    let mut raw = vec![];
    tx.write(&mut raw)?;
    Ok(hex::encode(raw))
}
fn decode(raw: &str) -> Result<Transaction> {
    Ok(Transaction::read(&hex::decode(raw)?[..], BranchId::Nu6_3)?)
}
fn coin_at(tx: &Transaction, index: u32) -> Result<Coin> {
    let out = tx
        .transparent_bundle()
        .context("transparent bundle")?
        .vout
        .get(index as usize)
        .context("output index")?;
    Ok(Coin {
        txid: tx.txid().to_string(),
        vout: index,
        value_zat: out.value().into_u64(),
        script: hex::encode(&out.script_pubkey().0 .0),
    })
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

struct Rpc {
    url: String,
    agent: ureq::Agent,
}
impl Rpc {
    fn new(port: u16) -> Result<Self> {
        ensure!(port >= 20000, "isolated high RPC port required");
        let rpc = Self {
            url: format!("http://127.0.0.1:{port}"),
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(120))
                .build(),
        };
        ensure!(
            rpc.call("getblockhash", json!([0]))? == GENESIS,
            "refusing non-regtest chain"
        );
        Ok(rpc)
    }
    fn response(&self, method: &str, params: Value) -> Result<Value> {
        Ok(self
            .agent
            .post(&self.url)
            .send_json(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))?
            .into_json()?)
    }
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let r = self.response(method, params)?;
        ensure!(r["error"].is_null(), "{method}: {}", r["error"]);
        Ok(r["result"].clone())
    }
    fn raw(&self, txid: &str) -> Result<Transaction> {
        decode(
            self.call("getrawtransaction", json!([txid, 0]))?
                .as_str()
                .context("raw hex")?,
        )
    }
    fn unspent(&self, coin: &Coin) -> Result<()> {
        ensure!(
            coin_at(&self.raw(&coin.txid)?, coin.vout)? == *coin,
            "chain prevout mismatch"
        );
        ensure!(
            !self
                .call("gettxout", json!([coin.txid, coin.vout, true]))?
                .is_null(),
            "stale or spent outpoint"
        );
        Ok(())
    }
    fn location(&self, txid: &str) -> Result<(u32, u32)> {
        let info = self.call("getrawtransaction", json!([txid, 1]))?;
        let block = self.call("getblock", json!([info["blockhash"], 1]))?;
        let index = block["tx"]
            .as_array()
            .context("block txids")?
            .iter()
            .position(|id| id == txid)
            .context("confirmed tx membership")?;
        Ok((
            block["height"].as_u64().context("height")? as u32,
            index as u32,
        ))
    }
    fn mine(&self, count: u32) -> Result<Value> {
        self.call("generatetoaddress", json!([count, mining_address()]))
    }
    fn confirm(&self, dir: &Path, label: &str, tx: &Transaction) -> Result<Value> {
        let raw = encode(tx)?;
        fs::write(dir.join(format!("{label}.hex")), &raw)?;
        ensure!(
            self.call("sendrawtransaction", json!([raw]))? == tx.txid().to_string(),
            "broadcast txid"
        );
        self.mine(1)?;
        let (height, index) = self.location(&tx.txid().to_string())?;
        ensure!(
            encode(&self.raw(&tx.txid().to_string())?)? == raw,
            "raw node roundtrip"
        );
        println!("CONFIRMED {label}: {} at {height}:{index}", tx.txid());
        Ok(json!({"stage":label,"txid":tx.txid().to_string(),"height":height,"tx_index":index}))
    }
    fn reject(&self, dir: &Path, label: &str, tx: &Transaction, class: &str) -> Result<Value> {
        let raw = encode(tx)?;
        fs::write(dir.join(format!("{label}.hex")), &raw)?;
        let r = self.response("sendrawtransaction", json!([raw]))?;
        let message = r["error"]["message"]
            .as_str()
            .context("expected node rejection")?;
        ensure!(
            r["error"]["code"] == -25 && message.contains(class),
            "unexpected rejection for {label}: {r}"
        );
        println!("REJECTED {label}: {message}");
        Ok(json!({"check":label,"rpc_response":r}))
    }
}

// Deliberately bounded provenance verifier for this single issuance and full-lot lineage.
// The independent JavaScript ledger replays every transaction in every exported block.
fn provenance(rpc: &Rpc, policy: &Policy) -> Result<()> {
    ensure!(policy.quantity == LOT.to_string(), "quantity policy");
    let etched = rpc.raw(&policy.etch_txid)?;
    ensure!(
        rpc.location(&policy.etch_txid)? == (policy.rune_height, policy.rune_index),
        "issuance position"
    );
    let b = etched.transparent_bundle().context("etch bundle")?;
    ensure!(
        b.vin.len() == 1
            && b.vout.len() == 2
            && coin_at(&etched, 0)?.script == role_script(SELLER)
            && coin_at(&etched, 1)?.script == etch_script()
            && coin_at(&etched, 1)?.value_zat == 0,
        "unexpected issuance"
    );
    let prev = b.vin[0].prevout();
    let commitment = rpc.raw(&prev.txid().to_string())?;
    ensure!(
        coin_at(&commitment, prev.n())?.script == commitment_script(),
        "etch commitment script"
    );
    ensure!(
        rpc.location(&commitment.txid().to_string())?.0 + 6 <= policy.rune_height,
        "immature commitment"
    );
    let unlocking = &b.vin[0].script_sig().0 .0;
    ensure!(
        unlocking.ends_with(&push(&redeem_script())),
        "redeem script reveal"
    );
    let mut current = coin_at(&etched, 0)?;
    for id in &policy.ancestors {
        let tx = rpc.raw(id)?;
        rpc.location(id)?;
        let b = tx.transparent_bundle().context("transfer bundle")?;
        ensure!(
            b.vin.len() == 1 && b.vin[0].prevout() == &outpoint(&current)? && b.vout.len() == 2,
            "broken full-lot lineage"
        );
        ensure!(
            coin_at(&tx, 1)?.script == transfer_script(policy.rune_height, policy.rune_index, 0)
                && coin_at(&tx, 1)?.value_zat == 0,
            "lineage allocation"
        );
        current = coin_at(&tx, 0)?;
    }
    ensure!(
        current == policy.asset && current.script == role_script(SELLER),
        "asset lineage/policy mismatch"
    );
    rpc.unspent(&policy.asset)
}
fn validate_seller(policy: &Policy, proposal: &Proposal) -> Result<()> {
    ensure!(
        policy.price_zat == PRICE && policy.fee_zat == FEE && policy.expiry == EXPIRY,
        "fixture seller policy"
    );
    ensure!(
        proposal.expiry == policy.expiry && proposal.inputs == [policy.asset.clone()],
        "seller asset index/header"
    );
    ensure!(
        proposal.outputs
            == [Output {
                value_zat: policy.price_zat + policy.asset.value_zat,
                script: role_script(SELLER)
            }],
        "seller payout must exactly refund carrier plus price at output 0"
    );
    Ok(())
}
fn validate_buyer(policy: &Policy, proposal: &Proposal) -> Result<()> {
    ensure!(
        policy.price_zat == PRICE && policy.fee_zat == FEE && policy.expiry == EXPIRY,
        "fixture buyer policy"
    );
    ensure!(
        proposal.expiry == policy.expiry
            && proposal.inputs == [policy.asset.clone(), policy.funding.clone()],
        "buyer input position/header"
    );
    ensure!(
        policy.funding.script == role_script(BUYER),
        "buyer funding key"
    );
    let change = policy
        .funding
        .value_zat
        .checked_sub(policy.price_zat + policy.fee_zat)
        .context("insufficient funds")?;
    ensure!(
        proposal.outputs
            == [
                Output {
                    value_zat: policy.price_zat + policy.asset.value_zat,
                    script: role_script(SELLER)
                },
                Output {
                    value_zat: change,
                    script: role_script(BUYER)
                },
                Output {
                    value_zat: 0,
                    script: transfer_script(policy.rune_height, policy.rune_index, 1)
                },
            ],
        "buyer payment/change/full-lot allocation"
    );
    Ok(())
}
fn seller_sign(rpc: &Rpc, policy: &Policy, proposal: &Proposal) -> Result<SellerSignature> {
    validate_seller(policy, proposal)?;
    provenance(rpc, policy)?;
    Ok(SellerSignature {
        script_sig: sign(proposal, 0, SELLER, SighashType::SINGLE_ANYONECANPAY, None)?,
        digest: hex::encode(sighash(proposal, 0, SighashType::SINGLE_ANYONECANPAY)?),
    })
}
fn verify_seller(proposal: &Proposal, signature: &SellerSignature) -> Result<()> {
    let bytes = hex::decode(&signature.script_sig)?;
    let len = usize::from(*bytes.first().context("empty signature")?);
    ensure!(
        len > 1
            && len <= 73
            && bytes.len() == len + 35
            && bytes[len] == 0x83
            && bytes[len + 1] == 33
            && bytes[len + 2..] == public(SELLER).serialize(),
        "seller signature shape/hash mode/key"
    );
    let digest = sighash(proposal, 0, SighashType::SINGLE_ANYONECANPAY)?;
    ensure!(
        hex::encode(digest) == signature.digest,
        "seller committed payout/header changed"
    );
    Secp256k1::new().verify_ecdsa(
        &Message::from_digest(digest),
        &Signature::from_der(&bytes[1..len])?,
        &public(SELLER),
    )?;
    Ok(())
}
fn buyer_sign(
    rpc: &Rpc,
    policy: &Policy,
    proposal: &Proposal,
    seller: &SellerSignature,
) -> Result<Transaction> {
    validate_buyer(policy, proposal)?;
    provenance(rpc, policy)?;
    rpc.unspent(&policy.funding)?;
    verify_seller(proposal, seller)?;
    // Funding is the exact token-free split created from a coinbase by this fixture.
    let funding = rpc.raw(&policy.funding.txid)?;
    let b = funding.transparent_bundle().context("funding bundle")?;
    ensure!(
        b.vin.len() == 1
            && !b
                .vout
                .iter()
                .any(|o| o.script_pubkey().0 .0.starts_with(&[0x6a])),
        "unexpected funding lineage"
    );
    ensure!(
        rpc.raw(&b.vin[0].prevout().txid().to_string())?
            .transparent_bundle()
            .context("funding parent")?
            .is_coinbase(),
        "funding must descend directly from coinbase"
    );
    assemble(
        proposal,
        &[
            seller.script_sig.clone(),
            sign(proposal, 1, BUYER, SighashType::ALL, None)?,
        ],
    )
}
fn full_proposal(policy: &Policy) -> Proposal {
    Proposal {
        inputs: vec![policy.asset.clone(), policy.funding.clone()],
        outputs: vec![
            Output {
                value_zat: policy.price_zat + policy.asset.value_zat,
                script: role_script(SELLER),
            },
            Output {
                value_zat: policy.funding.value_zat - policy.price_zat - policy.fee_zat,
                script: role_script(BUYER),
            },
            Output {
                value_zat: 0,
                script: transfer_script(policy.rune_height, policy.rune_index, 1),
            },
        ],
        expiry: policy.expiry,
    }
}
fn child(dir: &Path, args: &[&str], expected_success: bool) -> Result<Value> {
    let result = Command::new(std::env::current_exe()?)
        .args(args)
        .current_dir(dir)
        .output()?;
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    ensure!(
        result.status.success() == expected_success,
        "child {:?} unexpected result: {stdout} {stderr}",
        args
    );
    Ok(json!({"command":args,"success":result.status.success(),"stdout":stdout,"stderr":stderr}))
}

// Test setup and attack construction also run in a separate process. These are
// explicitly fixture-only operations, never an alternate production signing API.
fn fixture_sign(
    rpc: &Rpc,
    kind: &str,
    p: &Proposal,
    seller: Option<SellerSignature>,
) -> Result<Transaction> {
    ensure!(p.expiry == EXPIRY, "fixture expiry");
    for coin in &p.inputs {
        rpc.unspent(coin)?;
    }
    let signatures = match kind {
        "funding" => {
            ensure!(
                p.inputs.len() == 1 && p.inputs[0].script == role_script(MINER),
                "mining fixture input"
            );
            vec![sign(p, 0, MINER, SighashType::ALL, None)?]
        }
        "etch" => {
            ensure!(
                p.inputs.len() == 1
                    && p.inputs[0].script == commitment_script()
                    && p.outputs[1].script == etch_script(),
                "etch fixture"
            );
            vec![sign(
                p,
                0,
                SELLER,
                SighashType::ALL,
                Some(&redeem_script()),
            )?]
        }
        "cancel" => {
            ensure!(
                p.inputs.len() == 1
                    && p.inputs[0].script == role_script(SELLER)
                    && p.outputs[0].script == role_script(SELLER),
                "cancel fixture"
            );
            vec![sign(p, 0, SELLER, SighashType::ALL, None)?]
        }
        "attack" => {
            ensure!(
                p.inputs.len() == 2 && p.inputs[1].script == role_script(BUYER),
                "attack fixture"
            );
            vec![
                seller.context("seller signature")?.script_sig,
                sign(p, 1, BUYER, SighashType::ALL, None)?,
            ]
        }
        _ => bail!("unknown fixture operation"),
    };
    assemble(p, &signatures)
}
fn fixture_child(
    dir: &Path,
    port: &str,
    kind: &str,
    p: &Proposal,
    commands: &mut Vec<Value>,
) -> Result<Transaction> {
    let proposal = format!("{kind}-fixture.json");
    let raw = format!("{kind}-fixture.hex");
    write_json(&dir.join(&proposal), p)?;
    commands.push(child(
        dir,
        &["fixture-sign", port, kind, &proposal, &raw],
        true,
    )?);
    decode(&fs::read_to_string(dir.join(raw))?)
}
fn export(rpc: &Rpc, dir: &Path) -> Result<u64> {
    let height = rpc
        .call("getblockcount", json!([]))?
        .as_u64()
        .context("height")?;
    let mut blocks = vec![];
    let mut raws = serde_json::Map::new();
    for h in 1..=height {
        let hash = rpc.call("getblockhash", json!([h]))?;
        let b = rpc.call("getblock", json!([hash, 1]))?;
        let mut txs = vec![];
        for id in b["tx"].as_array().context("block transactions")? {
            let tx = rpc.raw(id.as_str().context("txid")?)?;
            ensure!(
                tx.txid().to_string() == id.as_str().unwrap(),
                "raw txid mismatch"
            );
            raws.insert(tx.txid().to_string(), json!(encode(&tx)?));
            let bundle = tx
                .transparent_bundle()
                .context("fixture transparent bundle")?;
            let vin: Vec<Value> = bundle.vin.iter().map(|i| if bundle.is_coinbase() {json!({"coinbase":hex::encode(&i.script_sig().0.0)})} else {json!({"txid":i.prevout().txid().to_string(),"vout":i.prevout().n(),"scriptSig":{"hex":hex::encode(&i.script_sig().0.0)}})}).collect();
            let vout: Vec<Value> = bundle.vout.iter().enumerate().map(|(n,o)| json!({"n":n,"valueZat":o.value().into_u64(),"scriptPubKey":{"hex":hex::encode(&o.script_pubkey().0.0)}})).collect();
            txs.push(json!({"txid":tx.txid().to_string(),"vin":vin,"vout":vout}));
        }
        blocks.push(
            json!({"height":h,"hash":hash,"previousblockhash":b["previousblockhash"],"tx":txs}),
        );
    }
    write_json(&dir.join("blocks.json"), &blocks)?;
    write_json(
        &dir.join("replay.json"),
        &json!({"network":"regtest","mode":"complete","startHeight":1,"previousHash":GENESIS,"blocks":blocks}),
    )?;
    write_json(&dir.join("raw-transactions.json"), &raws)?;
    Ok(height)
}

fn demo(port: u16, dir: &Path) -> Result<()> {
    let rpc = Rpc::new(port)?;
    ensure!(
        rpc.call("getblockcount", json!([]))? == 0,
        "fresh node required"
    );
    fs::create_dir_all(dir)?;
    let dir = fs::canonicalize(dir)?;
    let dir = dir.as_path();
    let port = port.to_string();
    let blocks = rpc.mine(101)?;
    let b = rpc.call("getblock", json!([blocks[0], 1]))?;
    let coinbase = rpc.raw(b["tx"][0].as_str().context("coinbase id")?)?;
    let n = coinbase
        .transparent_bundle()
        .unwrap()
        .vout
        .iter()
        .position(|o| hex::encode(&o.script_pubkey().0 .0) == role_script(MINER))
        .context("mining output")?;
    let mined = coin_at(&coinbase, n as u32)?;
    let funding_value = (mined.value_zat - FEE - 200_000) / 2;
    let split = Proposal {
        inputs: vec![mined],
        outputs: vec![
            Output {
                value_zat: 200_000,
                script: commitment_script(),
            },
            Output {
                value_zat: funding_value,
                script: role_script(BUYER),
            },
            Output {
                value_zat: funding_value,
                script: role_script(BUYER),
            },
        ],
        expiry: EXPIRY,
    };
    let mut commands = vec![];
    let split_tx = fixture_child(dir, &port, "funding", &split, &mut commands)?;
    let mut confirmations = vec![rpc.confirm(dir, "commitment-funding", &split_tx)?];
    rpc.mine(5)?;
    let etch = Proposal {
        inputs: vec![coin_at(&split_tx, 0)?],
        outputs: vec![
            Output {
                value_zat: 200_000 - FEE,
                script: role_script(SELLER),
            },
            Output {
                value_zat: 0,
                script: etch_script(),
            },
        ],
        expiry: EXPIRY,
    };
    let etch_tx = fixture_child(dir, &port, "etch", &etch, &mut commands)?;
    confirmations.push(rpc.confirm(dir, "etch", &etch_tx)?);
    let (rune_height, rune_index) = rpc.location(&etch_tx.txid().to_string())?;
    let mut policy = Policy {
        asset: coin_at(&etch_tx, 0)?,
        funding: coin_at(&split_tx, 2)?,
        etch_txid: etch_tx.txid().to_string(),
        ancestors: vec![],
        price_zat: PRICE,
        fee_zat: FEE,
        quantity: LOT.to_string(),
        rune_height,
        rune_index,
        expiry: EXPIRY,
    };
    write_json(&dir.join("stale-policy.json"), &policy)?;
    let mut offer = full_proposal(&policy);
    offer.inputs.truncate(1);
    offer.outputs.truncate(1);
    write_json(&dir.join("stale-offer.json"), &offer)?;
    write_json(&dir.join("stale-proposal.json"), &full_proposal(&policy))?;
    commands.push(child(
        dir,
        &[
            "seller-sign",
            &port,
            "stale-policy.json",
            "stale-offer.json",
            "stale-signature.json",
        ],
        true,
    )?);
    commands.push(child(
        dir,
        &[
            "buyer-sign",
            &port,
            "stale-policy.json",
            "stale-proposal.json",
            "stale-signature.json",
            "stale-sale.hex",
        ],
        true,
    )?);
    let cancellation = Proposal {
        inputs: vec![policy.asset.clone()],
        outputs: vec![
            Output {
                value_zat: policy.asset.value_zat - FEE,
                script: role_script(SELLER),
            },
            Output {
                value_zat: 0,
                script: transfer_script(rune_height, rune_index, 0),
            },
        ],
        expiry: EXPIRY,
    };
    let cancelled = fixture_child(dir, &port, "cancel", &cancellation, &mut commands)?;
    confirmations.push(rpc.confirm(dir, "cancellation", &cancelled)?);
    commands.push(child(
        dir,
        &[
            "buyer-sign",
            &port,
            "stale-policy.json",
            "stale-proposal.json",
            "stale-signature.json",
            "must-not-exist.hex",
        ],
        false,
    )?);
    let stale_error = commands.last().unwrap()["stderr"].as_str().unwrap();
    ensure!(
        stale_error.contains("stale or spent outpoint"),
        "wrong stale refusal"
    );
    let mut rejections = vec![];
    let stale_asset = policy.asset.clone();
    policy.asset = coin_at(&cancelled, 0)?;
    policy.funding = coin_at(&split_tx, 1)?;
    policy.ancestors.push(cancelled.txid().to_string());
    write_json(&dir.join("seller-policy.json"), &policy)?;
    write_json(&dir.join("buyer-policy.json"), &policy)?;
    let proposal = full_proposal(&policy);
    let mut offer = proposal.clone();
    offer.inputs.truncate(1);
    offer.outputs.truncate(1);
    write_json(&dir.join("offer.json"), &offer)?;
    write_json(&dir.join("proposal.json"), &proposal)?;
    commands.push(child(
        dir,
        &[
            "seller-sign",
            &port,
            "seller-policy.json",
            "offer.json",
            "seller-signature.json",
        ],
        true,
    )?);
    let mut altered = proposal.clone();
    altered.outputs[0].value_zat -= 1;
    altered.outputs[1].value_zat += 1;
    write_json(&dir.join("altered-proposal.json"), &altered)?;
    commands.push(child(
        dir,
        &[
            "buyer-sign",
            &port,
            "buyer-policy.json",
            "altered-proposal.json",
            "seller-signature.json",
            "must-not-exist.hex",
        ],
        false,
    )?);
    ensure!(
        commands.last().unwrap()["stderr"]
            .as_str()
            .unwrap()
            .contains("buyer payment/change/full-lot allocation"),
        "wrong altered payment refusal"
    );
    let altered_tx = fixture_child(dir, &port, "attack", &altered, &mut commands)?;
    rejections.push(rpc.reject(
        dir,
        "altered-payment-node-rejection",
        &altered_tx,
        "ScriptInvalid",
    )?);
    commands.push(child(
        dir,
        &[
            "buyer-sign",
            &port,
            "buyer-policy.json",
            "proposal.json",
            "seller-signature.json",
            "sale.hex",
        ],
        true,
    )?);
    // A fresh invocation restores solely from serialized policy/offer/signature state.
    commands.push(child(
        dir,
        &[
            "buyer-sign",
            &port,
            "buyer-policy.json",
            "proposal.json",
            "seller-signature.json",
            "recovered-sale.hex",
        ],
        true,
    )?);
    ensure!(
        fs::read(dir.join("sale.hex"))? == fs::read(dir.join("recovered-sale.hex"))?,
        "signer restart changed transaction"
    );
    let mut competing_policy = policy.clone();
    competing_policy.funding = coin_at(&split_tx, 2)?;
    write_json(&dir.join("competing-policy.json"), &competing_policy)?;
    write_json(
        &dir.join("competing-proposal.json"),
        &full_proposal(&competing_policy),
    )?;
    commands.push(child(
        dir,
        &[
            "buyer-sign",
            &port,
            "competing-policy.json",
            "competing-proposal.json",
            "seller-signature.json",
            "competing-sale.hex",
        ],
        true,
    )?);
    let sale = decode(&fs::read_to_string(dir.join("sale.hex"))?)?;
    confirmations.push(rpc.confirm(dir, "sale", &sale)?);
    // Both spends are already confirmed stale. Their independent RPC checks
    // can share Zebra's missing-UTXO timeout without delaying each other.
    let stale = decode(&fs::read_to_string(dir.join("stale-sale.hex"))?)?;
    let competing = decode(&fs::read_to_string(dir.join("competing-sale.hex"))?)?;
    let rejection_funding = &competing_policy.funding;
    rpc.unspent(rejection_funding)?;
    let funding_before = rpc.call(
        "gettxout",
        json!([rejection_funding.txid, rejection_funding.vout, true]),
    )?;
    ensure!(
        !funding_before.is_null(),
        "alternate funding must be unspent before rejected submissions"
    );
    let stale_asset_state = rpc.call(
        "gettxout",
        json!([stale_asset.txid, stale_asset.vout, true]),
    )?;
    let competing_asset_state = rpc.call(
        "gettxout",
        json!([policy.asset.txid, policy.asset.vout, true]),
    )?;
    ensure!(
        stale_asset_state.is_null(),
        "cancelled offer token input must already be spent"
    );
    ensure!(
        competing_asset_state.is_null(),
        "competing sale token input must already be spent"
    );
    let (stale_result, competing_result) = std::thread::scope(|scope| {
        let stale_check = scope.spawn(|| {
            rpc.reject(
                dir,
                "cancelled-offer-node-rejection",
                &stale,
                "could not find transparent input UTXO in the best chain or mempool",
            )
        });
        let competing_check = rpc.reject(
            dir,
            "competing-sale-node-rejection",
            &competing,
            "could not find transparent input UTXO in the best chain or mempool",
        );
        (
            stale_check.join().expect("stale RPC thread"),
            competing_check,
        )
    });
    rejections.push(stale_result?);
    rejections.push(competing_result?);
    rpc.unspent(rejection_funding)?;
    let funding_after = rpc.call(
        "gettxout",
        json!([rejection_funding.txid, rejection_funding.vout, true]),
    )?;
    ensure!(
        !funding_after.is_null(),
        "alternate funding must remain unspent after rejected submissions"
    );
    commands.push(child(
        dir,
        &["recover", &port, "sale.hex", "recovery.json"],
        true,
    )?);
    let recovered: Value = read_json(&dir.join("recovery.json"))?;
    ensure!(
        recovered["confirmed"] == true,
        "post-confirmation process recovery"
    );
    let tip = export(&rpc, dir)?;
    write_json(
        &dir.join("receipt.json"),
        &json!({"schema":"zrunes-transparent-settlement-regtest-v1","network":"regtest","genesis":GENESIS,"tx_version":5,"branch":"NU6.3","scope":"settlement primitive; not ZMarket envelope interoperability","name":NAME,"quantity":LOT.to_string(),"rune_id":format!("{rune_height}:{rune_index}"),"price_zat":PRICE,"fee_zat":FEE,"seller_payment_zat":PRICE+policy.asset.value_zat,"seller_payment_script":role_script(SELLER),"buyer_script":role_script(BUYER),"buyer_outpoint":format!("{}:1",sale.txid()),"confirmations":confirmations,"rejections":rejections,"rejection_funding":{"coin":rejection_funding,"before":funding_before,"after":funding_after},"rejection_assets":{"cancelled_offer":{"coin":stale_asset,"gettxout":stale_asset_state},"competing_sale":{"coin":policy.asset,"gettxout":competing_asset_state}},"process_commands":commands,"recovery":recovered,"export":{"from_height":1,"through_height":tip,"blocks":"blocks.json","raw_transactions":"raw-transactions.json"}}),
    )?;
    println!("COMPLETE: {}", dir.display());
    Ok(())
}
fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("demo") if a.len() == 4 => demo(a[2].parse()?,Path::new(&a[3])),
        Some("fixture-sign") if a.len() == 6 => {let rpc=Rpc::new(a[2].parse()?)?; let seller=if a[3]=="attack" {Some(read_json(Path::new("seller-signature.json"))?)} else {None}; let tx=fixture_sign(&rpc,&a[3],&read_json(Path::new(&a[4]))?,seller)?; fs::write(&a[5],encode(&tx)?)?; Ok(())},
        Some("seller-sign") if a.len() == 6 => write_json(Path::new(&a[5]),&seller_sign(&Rpc::new(a[2].parse()?)?,&read_json(Path::new(&a[3]))?,&read_json(Path::new(&a[4]))?)?),
        Some("buyer-sign") if a.len() == 7 => {let tx = buyer_sign(&Rpc::new(a[2].parse()?)?,&read_json(Path::new(&a[3]))?,&read_json(Path::new(&a[4]))?,&read_json(Path::new(&a[5]))?)?; fs::write(&a[6],encode(&tx)?)?; Ok(())},
        Some("recover") if a.len() == 5 => {let rpc = Rpc::new(a[2].parse()?)?; let tx = decode(&fs::read_to_string(&a[3])?)?; let location = rpc.location(&tx.txid().to_string())?; ensure!(encode(&rpc.raw(&tx.txid().to_string())?)? == encode(&tx)?,"recovered raw mismatch"); write_json(Path::new(&a[4]),&json!({"txid":tx.txid().to_string(),"confirmed":true,"height":location.0,"tx_index":location.1,"raw_match":true}))},
        _ => bail!("usage: demo PORT DIR | seller-sign PORT POLICY OFFER OUT | buyer-sign PORT POLICY PROPOSAL SIGNATURE OUT | recover PORT RAW OUT"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Policy, Proposal) {
        let policy = Policy {
            asset: Coin {
                txid: "01".repeat(32),
                vout: 0,
                value_zat: 140_000,
                script: role_script(SELLER),
            },
            funding: Coin {
                txid: "02".repeat(32),
                vout: 1,
                value_zat: 500_000_000,
                script: role_script(BUYER),
            },
            etch_txid: "03".repeat(32),
            ancestors: vec![],
            price_zat: PRICE,
            fee_zat: FEE,
            quantity: LOT.to_string(),
            rune_height: 108,
            rune_index: 1,
            expiry: EXPIRY,
        };
        let proposal = full_proposal(&policy);
        (policy, proposal)
    }
    #[test]
    fn seller_signature_survives_buyer_append_but_not_payout_change() {
        let (_, full) = fixture();
        let mut offer = full.clone();
        offer.inputs.truncate(1);
        offer.outputs.truncate(1);
        let digest = sighash(&offer, 0, SighashType::SINGLE_ANYONECANPAY).unwrap();
        assert_eq!(
            digest,
            sighash(&full, 0, SighashType::SINGLE_ANYONECANPAY).unwrap()
        );
        let signature = SellerSignature {
            script_sig: sign(&offer, 0, SELLER, SighashType::SINGLE_ANYONECANPAY, None).unwrap(),
            digest: hex::encode(digest),
        };
        verify_seller(&full, &signature).unwrap();
        let mut altered = full;
        altered.outputs[0].value_zat -= 1;
        assert!(verify_seller(&altered, &signature).is_err());
    }
    #[test]
    fn economics_reject_wrong_allocation_fee_or_position() {
        let (policy, full) = fixture();
        validate_buyer(&policy, &full).unwrap();
        let mut p = full.clone();
        p.outputs[2].script = transfer_script(108, 1, 0);
        assert!(validate_buyer(&policy, &p).is_err());
        let mut p = full.clone();
        p.outputs[1].value_zat -= 1;
        assert!(validate_buyer(&policy, &p).is_err());
        let mut p = full.clone();
        p.inputs.swap(0, 1);
        assert!(validate_buyer(&policy, &p).is_err());
        let mut p = full;
        p.expiry += 1;
        assert!(validate_buyer(&policy, &p).is_err());
    }
    #[test]
    fn v5_raw_roundtrip_and_commitment_shape() {
        let (_, p) = fixture();
        let tx = assemble(
            &p,
            &[
                sign(&p, 0, SELLER, SighashType::SINGLE_ANYONECANPAY, None).unwrap(),
                sign(&p, 1, BUYER, SighashType::ALL, None).unwrap(),
            ],
        )
        .unwrap();
        assert_eq!(
            encode(&tx).unwrap(),
            encode(&decode(&encode(&tx).unwrap()).unwrap()).unwrap()
        );
        assert!(encode(&tx).unwrap().starts_with("05000080"));
        assert_eq!(redeem_script().len(), 69);
        assert_eq!(name_value("AAAA"), 18278);
    }
}
