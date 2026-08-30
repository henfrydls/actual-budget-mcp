/** What the caller passed in the tool's confirmation arguments. */
export interface ConfirmationInput {
  confirm?: boolean;
  confirm_name?: string;
}

export interface ConfirmationRequest {
  /** What is being deleted, e.g. `Category: Groceries`. */
  subject: string;
  /** Lines describing what would be lost. Already indented by the caller. */
  losses: string[];
  /** The caller's confirmation arguments. */
  input: ConfirmationInput;
  /**
   * The target's exact name, when the tool resolves its target *by name*. Set
   * it and the caller must echo it back. Leave it undefined for tools that take
   * an exact id: there is no wrong-target ambiguity for an echo to catch, so
   * requiring one would be empty ceremony.
   */
  confirmName?: string;
  /** A non-destructive option to offer first, when one exists. */
  alternative?: string;
}

export interface ConfirmationOutcome {
  confirmed: boolean;
  /** The preview to return to the caller. Empty when confirmed. */
  lines: string[];
}

/**
 * The preview-then-confirm guard shared by every destructive tool.
 *
 * It lives here rather than inline per tool for the reason #44 taught: a guard
 * that each tool re-implements is a guard the next tool forgets. A tool states
 * what it would destroy; this decides whether destroying it is authorised.
 */
export function requireConfirmation(request: ConfirmationRequest): ConfirmationOutcome {
  const { subject, losses, input, confirmName, alternative } = request;

  // A mismatched echo is a wrong-target signal, not a missing step: fail loudly
  // rather than falling through to another preview.
  if (
    confirmName !== undefined &&
    input.confirm &&
    input.confirm_name !== undefined &&
    input.confirm_name !== confirmName
  ) {
    throw new Error(
      `confirm_name "${input.confirm_name}" does not match "${confirmName}". Nothing was deleted.`,
    );
  }

  const echoSatisfied = confirmName === undefined || input.confirm_name !== undefined;
  if (input.confirm && echoSatisfied) {
    return { confirmed: true, lines: [] };
  }

  const retry =
    confirmName === undefined
      ? '  confirm: true'
      : `  confirm: true, confirm_name: "${confirmName}"`;

  const lines = [
    'Nothing was deleted. Review what this would destroy:',
    `  ${subject}`,
    ...losses,
  ];
  if (alternative) {
    lines.push('', alternative);
  }
  lines.push('', 'To really delete it, call again with:', retry);

  return { confirmed: false, lines };
}
