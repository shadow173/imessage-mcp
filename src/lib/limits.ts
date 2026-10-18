/**
 * get_updates never holds a call longer than this, whatever wait_seconds says: common MCP clients give up at 60 s. The
 * CLI's watch loop uses it too.
 */
export const MAX_UPDATE_HOLD_S = 50;
