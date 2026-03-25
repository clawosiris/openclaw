# Sandbox idmap Mount Support Specification

## Context

When running OpenClaw with rootless Podman on Linux, files in bind-mounted directories are not writable by the sandboxed agent process due to UID mapping mismatches.

**Root cause:** Rootless Podman maps the host user to UID 0 inside the container. The sandbox process runs as a different user, causing permission issues with bind mounts.

**Solution:** Podman ≥ 4.3 supports `idmap` as a bind mount option, which remaps host UIDs to container UIDs at the mount level.

Related issue: https://github.com/openclaw/openclaw/issues/34594

## Requirements

### 1. Support idmap on docker.binds

- [ ] Extend bind mount format to accept options: `"host:container:rw,idmap"`
- [ ] Parse `idmap` flag from bind spec options
- [ ] Convert `-v` style binds with idmap to `--mount` syntax when idmap is present
- [ ] Validate idmap option is not combined with incompatible flags

### 2. Support idmap on workspace mounts

- [ ] Add `docker.workspaceIdmap` config option (boolean)
- [ ] When enabled, use `--mount` with `idmap` for workspace mounts
- [ ] Apply to both main workspace and agent workspace mounts

### 3. Backward compatibility

- [ ] Default behavior unchanged (no idmap)
- [ ] `-v` syntax preserved for mounts without idmap
- [ ] Works with both Docker and Podman (idmap ignored on Docker)

## Interface

### Config Schema

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          // Existing: "host:container:rw" or "host:container:ro"
          // New: "host:container:rw,idmap" 
          binds: ["/host/path:/container/path:rw,idmap"],
          
          // New option for workspace mounts
          workspaceIdmap: true,
        }
      }
    }
  }
}
```

### Implementation Notes

**Bind format parsing:**
- Current: `host:container[:ro|rw]`
- New: `host:container[:ro|rw][,idmap]`

**Docker command translation:**
- Without idmap: `-v /host:/container:rw`
- With idmap: `--mount type=bind,source=/host,target=/container,idmap`

**idmap syntax (Podman):**
- Basic: `,idmap` (uses container's user namespace mapping)
- Custom: `,idmap=uids=0-1-10:10-100-100` (explicit mapping)

For MVP, support only basic `idmap` flag (boolean).

## Acceptance Criteria

- [ ] `binds: ["/src:/src:rw,idmap"]` generates `--mount type=bind,source=/src,target=/src,idmap`
- [ ] `workspaceIdmap: true` applies idmap to workspace mounts
- [ ] Tests cover bind parsing, arg generation, and validation
- [ ] Existing bind syntax works unchanged
- [ ] Security validation still applies to idmap binds
