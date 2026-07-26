# Releasing

## One-time setup

You need an Apple Developer membership and a "Developer ID Application" certificate in your login keychain. Check it is there:

```sh
security find-identity -v -p codesigning
```

Store notarization credentials once, as a keychain profile named `foglio`. Run this in a terminal rather than through a tool, because it prompts for the password and needs a real TTY to read it:

```sh
xcrun notarytool store-credentials foglio \
  --apple-id "you@example.com" \
  --team-id 8XX87M89M2
```

The password it asks for is an app-specific password generated at <https://account.apple.com/account/manage>, not your Apple ID password. If it returns a 403 about a missing or expired agreement, sign in at <https://developer.apple.com/account> and accept the pending Apple Developer Program License Agreement first.

Universal builds need both Mac architectures installed:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Homebrew's Rust only carries the host architecture, so if `cargo` comes from Homebrew the x86_64 half of the build fails with a missing standard library. Put rustup's toolchain first for release builds:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```

## Cutting a release

1. Run the tests.

   ```sh
   npm test
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

2. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. All three must match.

3. Build and sign a universal binary, so one dmg runs on both Apple Silicon and Intel.

   ```sh
   export PATH="$HOME/.cargo/bin:$PATH"
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Francesco Moramarco (8XX87M89M2)"
   npm run tauri build -- --target universal-apple-darwin
   ```

   Bundles land under `src-tauri/target/universal-apple-darwin/release/bundle/`.

4. Notarize, then staple the ticket onto both the dmg and the app. Stapling the app as well means a first launch works offline.

   ```sh
   VERSION=0.1.1
   BUNDLE=src-tauri/target/universal-apple-darwin/release/bundle
   DMG="$BUNDLE/dmg/Foglio_${VERSION}_universal.dmg"

   xcrun notarytool submit "$DMG" --keychain-profile foglio --wait
   xcrun stapler staple "$DMG"
   xcrun stapler staple "$BUNDLE/macos/Foglio.app"
   ```

   Submission usually takes a few minutes. If it is rejected, `xcrun notarytool log <submission-id> --keychain-profile foglio` says why.

5. Check Gatekeeper accepts it.

   ```sh
   spctl -a -t open --context context:primary-signature -vv "$DMG"
   ```

   Expect `accepted` and `source=Notarized Developer ID`. Before notarizing, the same command reports `rejected` with `source=Unnotarized Developer ID`.

6. Publish, and confirm the download works the way a stranger gets it.

   ```sh
   gh release create "v$VERSION" "$DMG#Foglio $VERSION (universal — Apple Silicon and Intel)" \
     --title "Foglio $VERSION" --notes-file notes.md --latest

   # download it back, mark it as quarantined the way a browser would, and re-check
   gh release download "v$VERSION" --pattern "*.dmg" --dir /tmp/foglio-check
   xattr -w com.apple.quarantine "0081;00000000;Safari;" /tmp/foglio-check/*.dmg
   spctl -a -t open --context context:primary-signature -vv /tmp/foglio-check/*.dmg
   ```

## Notes

- A build without `APPLE_SIGNING_IDENTITY` set is unsigned, which is what contributors get. Only release builds need the certificate.
- `lipo -archs <app>/Contents/MacOS/foglio` confirms a universal build really carries both architectures. It should print `x86_64 arm64`.
