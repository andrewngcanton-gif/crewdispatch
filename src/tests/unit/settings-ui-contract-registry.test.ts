// settings-ui-contract-registry.test.ts — fail closed when a production
// provider is registered without an executable Settings UI contract fixture.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS_PROVIDER_IDS,
  defaultSettingsProviders
} from "../../config/settings-registry";
import {
  SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES,
  type SettingsUiContractBrowserFixture
} from "../helpers/settings-ui-contract-fixtures";

test("every registered Settings provider declares a contract profile and executable browser fixture", () => {
  const definitions = defaultSettingsProviders();
  const registered = [...DEFAULT_SETTINGS_PROVIDER_IDS].sort();
  const fixtureIds = Object.keys(SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES).sort();
  assert.deepEqual(definitions.map((definition) => definition.id).sort(), registered, "the production registry and exported provider-id union stay identical");
  assert.deepEqual(fixtureIds, registered, "every production provider has an executable Settings browser fixture");

  for (const definition of definitions) {
    const id = definition.id as keyof typeof SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES;
    const fixture: SettingsUiContractBrowserFixture = SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES[id];
    assert.ok(fixture, `${definition.id}: Settings UI contract fixture exists`);
    assert.equal(fixture.providerId, definition.id, `${definition.id}: fixture identity matches the registry`);
    assert.equal(
      Boolean(definition.readCapabilities),
      definition.uiContract.readStrategy === "catalog-capabilities",
      `${definition.id}: read strategy matches the production definition`
    );
    assert.equal(
      fixture.recommendedPermissionMode,
      definition.uiContract.recommendedPermissionMode,
      `${definition.id}: recommended Permission mode is pinned by the registry and fixture`
    );
    if (definition.uiContract.modelSpecificReasoning) {
      assert.ok(fixture.defaultEffortId && fixture.fallbackEffortId, `${definition.id}: model-specific Reasoning declares both browser controls`);
      assert.ok(fixture.reasoning, `${definition.id}: model-specific Reasoning declares executable cross-model evidence`);
    }
    if (definition.uiContract.readStrategy === "catalog-capabilities") {
      assert.equal(typeof fixture.buildCapabilityPatch, "function", `${definition.id}: two-phase providers supply executable capability evidence`);
    }
  }
});
