import type { OpenClawPluginApi } from "openclaw/plugin-sdk/matrix";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/matrix";
import { matrixPlugin } from "./src/channel.js";
import { ensureMatrixCryptoRuntime } from "./src/matrix/deps.js";
import { setMatrixRuntime } from "./src/runtime.js";
import { registerMatrixSubagentHooks } from "./src/subagent-hooks.js";
export type { MatrixThreadBindingsConfig } from "./src/types.js";

const plugin = {
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMatrixRuntime(api.runtime);
    void ensureMatrixCryptoRuntime({ log: api.logger.info }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.warn?.(`matrix: crypto runtime bootstrap failed: ${message}`);
    });
    try {
      registerMatrixSubagentHooks(api);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.error?.("matrix.thread.hook_registration_failed", {
        hookName: "registerMatrixSubagentHooks",
        error: message,
      });
    }
    api.registerChannel({ plugin: matrixPlugin });
  },
};

export default plugin;
