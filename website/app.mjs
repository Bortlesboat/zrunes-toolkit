import {
  decodeScript,
  exampleScripts,
  replaySample,
  sampleInfo,
} from "./engine.mjs";

const byId = (id) => document.getElementById(id);
const script = byId("script");
const outputs = byId("outputs");
const status = byId("decode-status");
const summary = byId("result-summary");
const fields = byId("decoded-fields");
const diagnostics = byId("decode-diagnostics");
const json = byId("decoded-json");
const error = byId("input-error");
const exampleButtons = [];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function definition(list, label, value) {
  list.append(element("dt", label), element("dd", value));
}

function resetResult(label, kind, message) {
  status.textContent = label;
  status.dataset.kind = kind;
  summary.textContent = message;
  fields.replaceChildren();
  diagnostics.replaceChildren();
  diagnostics.hidden = true;
  json.textContent = "";
  byId("raw-result").hidden = true;
  error.textContent = "";
  script.removeAttribute("aria-invalid");
}

function updateByteCount() {
  const hex = script.value.replace(/\s/g, "");
  byId("byte-count").textContent = /^(?:[0-9a-f]{2})+$/i.test(hex)
    ? `${hex.length / 2} bytes`
    : "— bytes";
}

function summaryFor(result) {
  if (result.ambiguity.length) return "This instruction needs interpretation.";
  if (result.kind === "malformed")
    return "The carrier contains an invalid instruction.";
  if (result.kind === "absent") return "No ZRunes instruction in this script.";
  if (result.name) return `Etching fields · ${result.name}`;
  const mint = result.fields.find((field) => field.tag === "24");
  if (mint) return `Mint fields · ${mint.values.join(":")}`;
  return "ZRunes instruction decoded.";
}

function decodeInput() {
  resetResult("Ready", "", "");
  updateByteCount();
  try {
    const result = decodeScript(script.value, Number(outputs.value));
    const unresolved = result.ambiguity.length > 0;
    status.dataset.kind = unresolved ? "unresolved" : result.kind;
    status.textContent = unresolved
      ? "Unresolved"
      : ({ valid: "Parsed", malformed: "Malformed", absent: "No carrier" }[
          result.kind
        ] ?? result.kind);
    summary.textContent = summaryFor(result);
    if (result.kind === "absent") {
      definition(
        fields,
        "Ledger behavior",
        "An ordinary spend can still move or burn existing tokens.",
      );
    } else {
      definition(fields, "Carrier output", String(result.dataOutput));
      for (const field of result.fields)
        definition(
          fields,
          field.label ?? `Tag ${field.tag}`,
          field.values.join(", "),
        );
      for (const edict of result.edicts)
        definition(
          fields,
          `Allocation ${edict.id}`,
          `${edict.amount} → output ${edict.output}`,
        );
    }
    const messages = [...result.errors, ...result.ambiguity];
    if (messages.length) {
      const list = element("ul");
      for (const message of messages) list.append(element("li", message));
      diagnostics.append(list);
      diagnostics.hidden = false;
    }
    json.textContent = JSON.stringify(result, null, 2);
    byId("raw-result").hidden = false;
  } catch (cause) {
    resetResult("Input error", "error", "Check the script and output count.");
    error.textContent = cause.message;
    script.setAttribute("aria-invalid", "true");
  }
}

for (const example of exampleScripts) {
  const button = element("button", example.label);
  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    script.value = example.hex;
    outputs.value = example.outputCount;
    for (const other of exampleButtons)
      other.setAttribute("aria-pressed", String(other === button));
    decodeInput();
  });
  exampleButtons.push(button);
  byId("example-buttons").append(button);
}

byId("decode-form").addEventListener("submit", (event) => {
  event.preventDefault();
  decodeInput();
});
for (const input of [script, outputs]) {
  input.addEventListener("input", () => {
    for (const button of exampleButtons)
      button.setAttribute("aria-pressed", "false");
    resetResult("Changed", "", "Decode to inspect the updated script.");
    updateByteCount();
  });
}

const integer = (value) => BigInt(value).toLocaleString("en-US");
function renderLedger(snapshot) {
  const rows = byId("asset-rows");
  rows.replaceChildren();
  const buttons = [];
  function selectAsset(asset, button) {
    for (const other of buttons) {
      other.setAttribute("aria-pressed", String(other === button));
      other.closest("tr").classList.toggle("selected", other === button);
    }
    byId("asset-name").textContent = asset.name || "Unnamed";
    const values = byId("asset-values");
    values.replaceChildren();
    definition(values, "Etching ID", asset.id);
    definition(values, "Sample supply", integer(asset.supply));
    definition(values, "Sample burned", integer(asset.burned));
    definition(values, "Sample circulating", integer(asset.circulating));
    definition(values, "Divisibility", String(asset.divisibility));
  }
  for (const asset of snapshot.assets) {
    const row = element("tr");
    const cell = element("td");
    const button = element("button", undefined, "token-button");
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.append(
      element("strong", asset.name || "Unnamed"),
      element("span", asset.id),
    );
    button.addEventListener("click", () => selectAsset(asset, button));
    buttons.push(button);
    cell.append(button);
    row.append(
      cell,
      element("td", integer(asset.supply), "numeric"),
      element("td", integer(asset.burned), "numeric"),
    );
    rows.append(row);
  }
  if (snapshot.assets.length) selectAsset(snapshot.assets[0], buttons[0]);
}

async function runSample() {
  const button = byId("replay-button");
  button.disabled = true;
  byId("sample-status").textContent = "Replaying recorded blocks…";
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = replaySample();
    renderLedger(snapshot);
    byId("sample-status").textContent =
      `${snapshot.assets.length} observed tokens reconstructed from the historical sample. Select a token to inspect it.`;
  } catch {
    byId("sample-status").textContent =
      "The sample could not be replayed. Try reloading the page.";
    byId("asset-rows").replaceChildren();
    byId("asset-name").textContent = "Sample unavailable";
    byId("asset-values").replaceChildren();
  } finally {
    button.disabled = false;
  }
}

byId("replay-button").addEventListener("click", runSample);
byId("sample-counts").textContent =
  `${sampleInfo.blocks} blocks · ${sampleInfo.transactions} transactions`;
byId("copy-install").addEventListener("click", async () => {
  const button = byId("copy-install");
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(byId("install-command").textContent);
    byId("copy-status").textContent = "Install command copied.";
  } catch {
    byId("copy-status").textContent =
      "Copy is unavailable here. Select the install command above to copy it.";
  } finally {
    button.disabled = false;
  }
});

byId("decode-button").disabled = false;
byId("copy-install").disabled = false;
exampleButtons[0].click();
runSample();
