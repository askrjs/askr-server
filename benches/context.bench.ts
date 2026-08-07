import { bench } from "vitest";
import { anonymousAuthContext, createServerContext } from "../src/context";

const request = new Request("http://example.test/items/42?view=full");
let sink: unknown;

bench("create a server context", () => {
  sink = createServerContext(request, anonymousAuthContext(), {});
});

void sink;
