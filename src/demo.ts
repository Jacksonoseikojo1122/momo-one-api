// A one-page demo against the sandbox provider (DEMO=on). No real money, no provider keys.

export function demoPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MoMo One-API sandbox</title>
<style>
  :root { --bg:#f6f5f1; --card:#fff; --ink:#1d1d1b; --muted:#6b6a64; --line:#e3e1d9; --accent:#0b6e4f; --ok:#0b6e4f; --bad:#a32020; --wait:#8a5a00; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; } .sub { color: var(--muted); margin: 0 0 20px; }
  .grid { display:grid; grid-template-columns: 330px 1fr; gap: 20px; align-items:start; }
  @media (max-width: 780px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
  label { display:block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
  input, select { width:100%; padding: 8px 10px; border:1px solid var(--line); border-radius:6px; font: inherit; background:#fff; }
  button { margin-top: 14px; width:100%; padding: 10px; border:0; border-radius:6px; background: var(--accent); color:#fff; font: inherit; font-weight:600; cursor:pointer; }
  .status { display:inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 13px; background:#eee; }
  .succeeded { background:#e3f2ea; color: var(--ok); } .failed, .reversed { background:#f7e3e3; color: var(--bad); }
  .pending, .action_required { background:#fff3d6; color: var(--wait); }
  dl { display:grid; grid-template-columns: 140px 1fr; gap: 4px 10px; margin: 12px 0; font-size: 14px; }
  dt { color: var(--muted); } dd { margin:0; font-variant-numeric: tabular-nums; word-break: break-all; }
  .ev { border-left: 3px solid var(--line); padding: 4px 10px; margin: 6px 0; font-size: 13px; }
  .ev b { font-family: ui-monospace, Consolas, monospace; }
  .muted { color: var(--muted); } code { background:#f0efe9; padding: 1px 5px; border-radius: 4px; }
  #otp { display:none; }
</style>
</head>
<body>
<main>
  <h1>MoMo One-API sandbox</h1>
  <p class="sub">One request format and one set of statuses for MTN MoMo, Telecel Cash, AirtelTigo Money and M-Pesa. This page uses the sandbox provider: no real money moves.</p>
  <div class="grid">
    <form class="card" id="f">
      <label for="dir">Type</label>
      <select id="dir"><option value="collection">Collection (customer pays you)</option><option value="payout">Payout (you pay the customer)</option></select>
      <label for="network">Network</label>
      <select id="network"><option value="mtn">MTN MoMo</option><option value="telecel">Telecel Cash</option><option value="airteltigo">AirtelTigo Money</option></select>
      <label for="phone">Customer phone</label>
      <select id="phone">
        <option value="0241234567">024 123 4567 (succeeds)</option>
        <option value="0240000001">024 000 0001 (customer declines)</option>
        <option value="0240000002">024 000 0002 (insufficient funds)</option>
        <option value="0240000004">024 000 0004 (needs an OTP)</option>
        <option value="0240000005">024 000 0005 (payout reversed)</option>
        <option value="0240000003">024 000 0003 (stays pending)</option>
      </select>
      <label for="amount">Amount (GHS)</label>
      <input id="amount" value="25.00" inputmode="decimal">
      <button>Send request</button>
      <p class="muted" style="font-size:13px;margin:12px 0 0">The last four digits pick the outcome. See <code>docs/sandbox.md</code>.</p>
    </form>
    <section class="card" id="out"><p class="muted">Send a request to see the payment move through its states.</p></section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let timer = null;
const ghs = (p) => "GHS " + (p / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
function el(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; }

function render({ payment: p, events }) {
  const rows = [["Payment", p.id], ["Amount", ghs(p.amount)], ["Phone", p.phone], ["Network", p.network], ["Provider", p.provider],
    ["Your reference", p.reference], ["Provider status", p.provider_status || "-"]];
  if (p.failure) rows.push(["Why it failed", p.failure.code + ": " + p.failure.message]);
  const otp = el("form", { id: "otpf" }, el("label", { textContent: p.action ? p.action.message : "" }), el("input", { id: "otpv", placeholder: "123456", inputMode: "numeric" }), el("button", { textContent: "Submit OTP" }));
  otp.style.display = p.status === "action_required" ? "block" : "none";
  otp.onsubmit = async (e) => { e.preventDefault(); await fetch("/demo/payments/" + p.id + "/otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ otp: $("otpv").value }) }); poll(p.id); };
  $("out").replaceChildren(
    el("span", { className: "status " + p.status, textContent: p.status.replace("_", " ") }),
    el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])),
    otp,
    el("h3", { textContent: "Webhook events", style: "font-size:15px;margin:16px 0 4px" }),
    ...events.map((e) => el("div", { className: "ev" }, el("b", { textContent: e.type }), " ", el("span", { className: "muted", textContent: new Date(e.created_at).toLocaleTimeString() }))),
  );
}

async function poll(id) {
  clearTimeout(timer);
  const data = await (await fetch("/demo/payments/" + id)).json();
  render(data);
  if (["pending", "action_required"].includes(data.payment.status) || (data.payment.direction === "payout" && data.payment.phone.endsWith("0005") && data.payment.status === "succeeded")) {
    timer = setTimeout(() => poll(id), 1000);
  }
}

$("f").onsubmit = async (e) => {
  e.preventDefault();
  const [w, f = ""] = $("amount").value.replace(/,/g, "").split(".");
  const body = { direction: $("dir").value, amount: Number(w) * 100 + Number((f + "00").slice(0, 2)), currency: "GHS", phone: $("phone").value, network: $("network").value,
    description: "Sandbox demo", customer: { name: "Ama Mensah", email: "ama@example.com" } };
  const res = await fetch("/demo/collections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const p = await res.json();
  if (!res.ok) { $("out").replaceChildren(el("p", { textContent: p.error })); return; }
  poll(p.id);
};
</script>
</body>
</html>`;
}
