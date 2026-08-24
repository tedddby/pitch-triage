/**
 * Feature flags.
 *
 * Everything defaults to OFF. An unfinished feature ships dark: the code path is
 * merged and on main, the flag that reaches it stays false, and main stays
 * releasable. See SPEC.md section 5.
 */
export interface Flags {
  /**
   * Send approved replies automatically instead of handing them back to the
   * consultant. NOT FINISHED — there is no SMTP path behind this yet, and the
   * approval UX assumes a human presses send. Leave off.
   */
  autoSend: boolean;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadFlags(env: NodeJS.ProcessEnv = process.env): Flags {
  return {
    autoSend: bool(env.FLAG_AUTO_SEND),
  };
}
