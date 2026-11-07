## 7.1.1

**Note:** 7.1.0 accidentally removed the `component-hook-factories` rule, causing errors for users who referenced it in their ESLint config. This is now fixed.

- Add deprecated no-op `component-hook-factories` rule for backwards compatibility. ([@mofeiZ](https://github.com/mofeiZ) in [#36307](https://github.com/react/react/pull/36307))

## 7.1.0

This release adds ESLint v10 support, improves performance by skipping compilation for non-React files, and includes compiler lint improvements including better `set-state-in-effect` detection, improved ref validation, and more helpful error reporting.

- Add ESLint v10 support. ([@azat-io](https://github.com/azat-io) in [#35720](https://github.com/react/react/pull/35720))
- Skip compilation for non-React files to improve performance. ([@josephsavona](https://github.com/josephsavona) in [#35589](https://github.com/react/react/pull/35589))
- Fix exhaustive deps bug with Flow type casting. ([@jorge-cab](https://github.com/jorge-cab) in [#35691](https://github.com/react/react/pull/35691))
- Fix `useEffectEvent` checks in component syntax. ([@jbrown215](https://github.com/jbrown215) in [#35041](https://github.com/react/react/pull/35041))
- Improved `set-state-in-effect` validation with fewer false negatives. ([@jorge-cab](https://github.com/jorge-cab) in [#35134](https://github.com/react/react/pull/35134), [@josephsavona](https://github.com/josephsavona) in [#35147](https://github.com/react/react/pull/35147), [@jackpope](https://github.com/jackpope) in [#35214](https://github.com/react/react/pull/35214), [@chesnokov-tony](https://github.com/chesnokov-tony) in [#35419](https://github.com/react/react/pull/35419), [@jsleitor](https://github.com/jsleitor) in [#36107](https://github.com/react/react/pull/36107))
- Improved ref validation for non-mutating functions and event handler props. ([@josephsavona](https://github.com/josephsavona) in [#35893](https://github.com/react/react/pull/35893), [@kolvian](https://github.com/kolvian) in [#35062](https://github.com/react/react/pull/35062))
- Compiler now reports all errors instead of stopping at the first. ([@josephsavona](https://github.com/josephsavona) in [#35873](https://github.com/react/react/pull/35873)–[#35884](https://github.com/react/react/pull/35884))
- Improved source locations and error display in compiler diagnostics. ([@nathanmarks](https://github.com/nathanmarks) in [#35348](https://github.com/react/react/pull/35348), [@josephsavona](https://github.com/josephsavona) in [#34963](https://github.com/react/react/pull/34963))

## 7.0.1

- Disallowed passing inline `useEffectEvent` values as JSX props to guard against accidental propagation. ([#34820](https://github.com/react/react/pull/34820) by [@jf-eirinha](https://github.com/jf-eirinha))
- Switch to `export =` so eslint-plugin-react-hooks emits correct types for consumers in Node16 ESM projects. ([#34949](https://github.com/react/react/pull/34949) by [@karlhorky](https://github.com/karlhorky))
- Tightened the typing of `configs.flat` so the `configs` export is always defined. ([#34950](https://github.com/react/react/pull/34950) by [@poteto](https://github.com/poteto))
- Fix named import runtime errors. ([#34951](https://github.com/react/react/pull/34951), [#34953](https://github.com/react/react/pull/34953) by [@karlhorky](https://github.com/karlhorky))

## 7.0.0

This release slims down presets to just 2 configurations (`recommended` and `recommended-latest`), and all compiler rules are enabled by default.

- **Breaking:** Removed `recommended-latest-legacy` and `flat/recommended` configs. The plugin now provides `recommended` (legacy and flat configs with all recommended rules),  and `recommended-latest` (legacy and flat configs with all recommended rules plus new bleeding edge experimental compiler rules). ([@poteto](https://github.com/poteto) in [#34757](https://github.com/react/react/pull/34757))

