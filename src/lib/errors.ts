export interface Candidate {
  kind: 'person' | 'chat';
  id: string;
  label: string;
  detail?: string;
}

/** Returned to the agent as an isError tool result so it can fix its call and retry. */
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public fix?: string,
    public candidates?: Candidate[],
  ) {
    super(message);
  }
}

/** One wording for "the Private API tier is off", shared by the tool layer and the live store. */
export const PRIVATE_API_OFF = {
  code: 'requires_private_api',
  message: 'This needs the Private API tier, which is not enabled on this Mac.',
  fix: "Tell the user it can't be done from here; the owner can turn it on with PRIVATE_API=imsg in the bridge config. Don't send a new message as a substitute unless the user asks.",
} as const;
