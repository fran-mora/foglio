# Releasing

## One-time setup

You need an Apple Developer membership and a "Developer ID Application" certificate in your login keychain. Check it is there:

```sh
security find-identity -v -p codesigning
```

Store notarization credentials once, as a keychain profile named `foglio`:

```sh
xcrun notarytool store-credentials foglio \
  --apple-id "you@example.com" \
  --team-id 8XX87M89M2 \
  --password "app-specific-password"
```

The password is an app-specific password generated at <https://account.apple.com/account/manage>, not your Apple ID password.

## Cutting a release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.

2. Build and sign a universal binary, so the dmg runs on both Apple Silicon and Intel:

   ```sh
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Francesco Moramarco (8XX87M89M2)"
   npm run tauri build -- --target universal-apple-darwin
   ```

   This needs both architectures installed: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
   Bundles land under `src-tauri/target/universal-apple-darwin/release/bundle/`.

3. Notarize and staple the ticket onto the dmg:

   ```sh
   DMG=src-tauri/target/release/bundle/dmg/Foglio_0.1.0_aarch64.dmg
   xcrun notarytool submit "$DMG" --keychain-profile foglio --wait
   xcrun stapler staple "$DMG"
   ```

   The submit step usually takes a few minutes. If it fails, `xcrun notarytool log <submission-id> --keychain-profile foglio` explains why.

4. Check Gatekeeper accepts it:

   ```sh
   spctl -a -t open --context context:primary-signature -vv "$DMG"
   ```

   Expect `accepted` and `source=Notarized Developer ID`. Before notarizing, the same command reports `rejected` with `source=Unnotarized Developer ID`.

5. Create the GitHub release and attach the stapled dmg.

## Notes

- A build without `APPLE_SIGNING_IDENTITY` set is unsigned, which is what contributors get. Only release builds need the certificate.
- The default build produces an Apple Silicon dmg. Add `--target universal-apple-darwin` for a universal binary that also runs on Intel Macs.
- Once the first notarized dmg is published, add a line to the README install section saying downloads are signed and notarized.
