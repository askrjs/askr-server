/** Release an owned, discarded response without waiting for application cleanup. */
export function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {
    // A failed or never-settling cancel hook must not replace the request outcome.
  });
}
