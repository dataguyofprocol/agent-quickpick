---
name: publish-openvsx
description: >
  Build, package, and publish a VS Code extension to the Open VSX Registry
  (open-vsx.org) with `vsce` and `ovsx`, then verify the new version is live.
  Use when the user asks to publish/release/ship an extension, push a new
  version to OpenVSX or the VS Code Marketplace, or asks whether the latest
  version is published. Handles version bump, changelog, token discovery,
  packaging, publishing, and post-publish index verification.
---

# Publish to Open VSX

Ships a VS Code extension to https://open-vsx.org. Optionally also to the VS Code Marketplace.

## 0. Check what's already published

Never assume. Compare local `package.json` version against the registry:

```bash
LOCAL=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
PUB=$(python3 -c "import json;print(json.load(open('package.json'))['publisher'])")
NAME=$(python3 -c "import json;print(json.load(open('package.json'))['name'])")
echo "local: $LOCAL"
curl -s "https://open-vsx.org/api/$PUB/$NAME" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('openvsx:',d.get('version'),d.get('timestamp'))"
```

If local == published, stop and say so — nothing to do unless the user wants a bump.

VS Code Marketplace check (separate registry, may not be published there):

```bash
curl -s -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
  -H "Accept: application/json;api-version=3.0-preview.1" -H "Content-Type: application/json" \
  -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$PUB.$NAME\"}]}],\"flags\":914}" \
  | python3 -c "import json,sys;e=json.load(sys.stdin)['results'][0]['extensions'];print(e[0]['versions'][0]['version'] if e else 'not found')"
```

## 1. Pre-flight

- `git status --short` — warn on a dirty tree; don't block, but say what's uncommitted.
- Confirm the version to ship. If the user wants a bump, edit `package.json` **and** add a `changelog.md` entry before packaging. Do not bump silently.
- Open VSX rejects re-publishing an existing version. A bump is mandatory for any re-release.

## 2. Find the token

Look, in order — do NOT print the value, only whether it was found:

```bash
env | grep -iE "ovsx|vsce" | sed 's/=.*/=<set>/'
ls .env .env.local 2>/dev/null && sed 's/=.*/=<set>/' .env 2>/dev/null
```

Common key names: `OVSX_PAT`, `OVSX_TOKEN`. If none found, ask the user for one —
they create it at https://open-vsx.org/user-settings/tokens. Never echo the token
into the transcript or into a command whose output you print.

The publisher's namespace must exist and the token must own it. If publish fails
with a namespace error:

```bash
npx ovsx create-namespace "$PUB" -p "$OVSX_PAT"
```

## 3. Compile and package

```bash
npm run compile
npx vsce package
```

Read the file list `vsce` prints. Flag anything that shouldn't ship (`.env`,
secrets, test fixtures, stray archives) and fix `.vscodeignore` before publishing
rather than after — a published version cannot be edited, only superseded.

## 4. Publish

Source the token in the same shell so it never appears in a printed command:

```bash
set -a; . ./.env; set +a
npx ovsx publish <name>-<version>.vsix -p "$OVSX_PAT"
```

Expect: `🚀  Published <publisher>.<name> v<version>`

For the VS Code Marketplace (needs a separate Azure DevOps PAT):

```bash
npx vsce publish --packagePath <name>-<version>.vsix -p "$VSCE_PAT"
```

## 5. Verify — the registry lags

**A successful publish message does not mean the version is queryable yet.** Open VSX
indexes asynchronously; the API returns the old version for roughly 30–90 seconds.
Poll rather than concluding failure from one 404:

```bash
for i in $(seq 1 8); do
  sleep 20
  V=$(curl -s "https://open-vsx.org/api/$PUB/$NAME" \
      | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
  echo "try $i: $V"
  [ "$V" = "$LOCAL" ] && break
done
```

Only report success once the API returns the new version. If it never appears after
~3 minutes, say so plainly and link the extension page — don't claim it published.

## 6. Clean up

The `.vsix` is a build artifact. Confirm `*.vsix` is gitignored; if not, add it or
delete the file. Then report:

- version published, and the link `https://open-vsx.org/extension/<publisher>/<name>`
- registries hit (Open VSX / Marketplace) and any deliberately skipped
- whether a git tag / release still needs creating (ask before tagging or pushing)

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Extension ... already exists` | version not bumped | bump `package.json`, repackage |
| `Unknown namespace` | namespace never created | `ovsx create-namespace` |
| `401 Unauthorized` | wrong/expired token, or token from the other registry | regenerate at open-vsx.org |
| API shows old version after publish succeeded | index lag | poll (step 5) |
| `vsce package` fails on missing repository field | incomplete `package.json` | add `repository`, `license`, `icon` |
