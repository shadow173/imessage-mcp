import { SCOPE_INFO } from './scopes.js';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{--bg:#f5f6f8;--card:#fff;--ink:#14171d;--muted:#5d6574;--line:#dde1e8;--accent:#0e7c6b;--accent-ink:#fff;--warn:#a8550a;--bad:#b42318;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--card:#161a21;--ink:#e7eaf0;--muted:#9ba3b1;--line:#2a303a;--accent:#3cc2a8;--accent-ink:#06231d;--warn:#f0a54e;--bad:#f2776b;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:24px 16px}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;display:grid;gap:18px}
h1{font-size:20px;margin:0;letter-spacing:-.01em}
.who{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chip{font-size:12.5px;font-weight:600;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.chip.host{color:var(--ink);font-family:ui-monospace,Menlo,monospace;font-weight:500}
.chip.warn{color:var(--warn);border-color:currentColor}
form{display:grid;gap:14px}
fieldset{border:0;margin:0;padding:0;display:grid;gap:8px}
label.scope{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:12px;cursor:pointer;min-height:44px}
label.scope input{grid-row:span 2;width:20px;height:20px;accent-color:var(--accent)}
label.scope b{font-size:14.5px}label.scope span{font-size:12.5px;color:var(--muted)}
label.pw{display:grid;gap:6px;font-size:13px;font-weight:600}
input[type=password]{font:inherit;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);min-height:44px}
.err{color:var(--bad);font-size:13.5px;margin:0}
.actions{display:grid;grid-template-columns:1fr 2fr;gap:8px}
button{font:inherit;font-weight:600;min-height:44px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.allow{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

export function consentPage(p: {
  req: string;
  clientName: string;
  redirectHost: string;
  loopback: boolean;
  requested: string[];
  error?: string;
}): string {
  const scopes = p.requested
    .map((s) => {
      const info = SCOPE_INFO[s];
      const lock = info.required ? ' checked disabled' : ' checked';
      return `<label class="scope"><input type="checkbox" name="scope" value="${s}"${lock} aria-describedby="d-${s.replace('.', '-')}"><b>${esc(info.label)}</b><span id="d-${s.replace('.', '-')}">${esc(info.detail)}</span></label>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect iMessage</title><style>${STYLE}</style></head><body><main>
<h1>Connect iMessage</h1>
<div class="who" aria-label="Requesting app"><span class="chip">${esc(p.clientName)}</span><span class="chip host" title="Returns to">${esc(p.redirectHost)}</span>${p.loopback ? '<span class="chip warn">local app</span>' : ''}</div>
<form method="post" action="/authorize">
<input type="hidden" name="req" value="${esc(p.req)}">
<fieldset aria-label="Permissions">${scopes}</fieldset>
<label class="pw">Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
${p.error ? `<p class="err" role="alert">${esc(p.error)}</p>` : ''}
<div class="actions"><button type="submit" name="action" value="deny" formnovalidate>Deny</button><button class="allow" type="submit" name="action" value="allow">Allow</button></div>
</form></main></body></html>`;
}

export function errorPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><h1>${esc(title)}</h1><p class="err">${esc(detail)}</p></main></body></html>`;
}
