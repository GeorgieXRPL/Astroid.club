# vendor/

This directory holds vendored dependencies that are not on the public npm
registry. They are committed in tarball form so the gateway can be built and
deployed from this repo alone, without requiring a sibling checkout of any
other repository.

## game-engine-enhanced.tgz

The runtime engine that powers the asteroid arena (ECS, WSGateway, anti-cheat,
WalletVerifier). Source lives at https://github.com/HeartOfMidgar/Enhanced-Game-Engine.

### Refreshing the tarball

When the engine source changes and you need to ship the update with the gateway,
run the helper script from the repo root:

```
npm run engine:pack
```

That script invokes `npm run build:lib && npm pack` in the sibling engine
checkout (default path: `../game-engine-enhanced`) and drops the resulting
tarball back into `vendor/game-engine-enhanced.tgz`.

You then need to refresh the local install so npm picks up the new tarball:

```
npm install
```

For local development you can keep iterating against the file path
(`file:../game-engine-enhanced`) by editing package.json — the tarball only
matters for production / Docker builds. If you go that route, remember to
flip it back before committing or the deploy will fail to resolve the
dependency.
