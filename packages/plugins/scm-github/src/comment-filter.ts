export const AO_VERIFY_MARKER = "<!-- ao-verify:";

export function filterAoVerifyComments<T extends { body: string }>(
  comments: readonly T[]
): T[] {
  return comments.filter((comment) => !comment.body.includes(AO_VERIFY_MARKER));
}
