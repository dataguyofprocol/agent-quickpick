/**
 * The OS-notification click URI must route back to the window that posted it.
 * `asExternalUri` stamps the editor's own scheme with `windowId`, which only a
 * real host can do — hence the host tier.
 */

import * as assert from "assert";
import * as vscode from "vscode";

import { windowFocusUri } from "../../extension";
import { sessionFromFocusUri } from "../../lifecycle";

suite("notification focus URI", () => {
  test("carries this window's id and still round-trips the session", async () => {
    const session = "Claude (2) & co";
    const uri = vscode.Uri.parse(await windowFocusUri("dataguyofprocol.agent-quickpick", session));
    assert.strictEqual(uri.scheme, vscode.env.uriScheme);
    assert.match(uri.query, /(^|&)windowId=\d+/, `no windowId in ${uri.toString()}`);
    assert.strictEqual(sessionFromFocusUri(uri.path, uri.query), session);
  });
});
