import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import type { SandboxWorkspaceAccess } from "./types.js";

function mainWorkspaceMountSuffix(access: SandboxWorkspaceAccess): "" | ":ro" {
  return access === "rw" ? "" : ":ro";
}

function agentWorkspaceMountSuffix(access: SandboxWorkspaceAccess): "" | ":ro" {
  return access === "ro" ? ":ro" : "";
}

function appendBindMount(args: string[], params: {
  source: string;
  target: string;
  readOnly: boolean;
  idmap: boolean;
}) {
  if (!params.idmap) {
    args.push("-v", `${params.source}:${params.target}${params.readOnly ? ":ro" : ""}`);
    return;
  }

  const mount = [
    "type=bind",
    `source=${params.source}`,
    `target=${params.target}`,
    ...(params.readOnly ? ["readonly"] : []),
    "idmap",
  ].join(",");
  args.push("--mount", mount);
}

export function appendWorkspaceMountArgs(params: {
  args: string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceIdmap?: boolean;
}) {
  const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;

  appendBindMount(args, {
    source: workspaceDir,
    target: workdir,
    readOnly: mainWorkspaceMountSuffix(workspaceAccess) === ":ro",
    idmap: params.workspaceIdmap === true,
  });
  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    appendBindMount(args, {
      source: agentWorkspaceDir,
      target: SANDBOX_AGENT_WORKSPACE_MOUNT,
      readOnly: agentWorkspaceMountSuffix(workspaceAccess) === ":ro",
      idmap: params.workspaceIdmap === true,
    });
  }
}
