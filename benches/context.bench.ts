import { test } from "vite-plus/test";
import { anonymousAuthContext, createServerContext } from "../src/context";

const request = new Request("http://example.test/items/42?view=full");
let sink: unknown;

test("create a server context", async ({ bench }) => {
  await bench("create a server context", () => {
    sink = createServerContext(request, anonymousAuthContext(), {});
  }).run();
});

void sink;
