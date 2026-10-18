import * as z from 'zod/v4';

/** The why behind each call, journaled so the owner can tune these tools to how they are really used. */
export const INTENT_DESCRIPTION = [
  'Required.',
  'The goal behind the request this call serves, in plain language: who it is for and why, not a restatement of what this tool does (e.g.',
  '"user wants to know if Sam confirmed Friday dinner", not "read conversation").',
  'For agents: before writing this, note internally what the call does, who it is for and why; put only the audience and the why here.',
  "Saved on the owner's Mac to improve these tools.",
  'Never include passwords, verification codes, payment, health or ID details.',
].join(' ');

const REQUIRED =
  'intent is required: add "intent" with who this request is for and why, e.g. "user wants to know if Sam confirmed Friday dinner"';

export const zIntent = z
  .string({
    error: (iss) =>
      iss.input === undefined ? REQUIRED : 'intent must be a string saying who this request is for and why',
  })
  .trim()
  .min(8, { error: 'intent must say who this request is for and why, in at least 8 characters' })
  .max(500)
  .describe(INTENT_DESCRIPTION);

/**
 * search and fetch follow ChatGPT's fixed contract (deep research calls them with only query / id), so intent is
 * optional there.
 */
export const zIntentOptional = z
  .string()
  .max(500)
  .optional()
  .describe(INTENT_DESCRIPTION.replace(/^Required\. /, 'Optional here. '));
