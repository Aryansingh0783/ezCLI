/* What the content security policy blocked, so a page part that stops working says why instead of
 * failing silently. Each blocked address is reported once: in the console, and in a short note. */
import { toast } from '../app';

const seen = new Set<string>();

document.addEventListener('securitypolicyviolation', (e) => {
  const what = `${e.effectiveDirective} ${e.blockedURI || 'inline'}`;
  if (seen.has(what)) return;
  seen.add(what);
  console.warn(`Blocked by the security policy: ${what} (in ${e.sourceFile || 'the page'}:${e.lineNumber || 0})`);
  toast(`Something was blocked by ezCLI's security policy (${e.effectiveDirective}). Please report it with what you were doing.`);
});
