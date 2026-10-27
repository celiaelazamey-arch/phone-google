import assert from 'node:assert/strict';

/**
 * Verifies strict N/N-1 backward compatibility between baseline MCP tool schemas
 * and current MCP tool schemas:
 * - Identical baseline tool names and order.
 * - Identical required parameter sets (no new required fields for legacy clients).
 * - Identical additionalProperties constraints.
 * - Every baseline property preserved with identical type/numeric bounds and superset enum values.
 */
export function assertBackwardCompatibleMcpTools(previousTools, currentTools) {
  assert.deepEqual(
    currentTools.map((t) => t.name),
    previousTools.map((t) => t.name),
    'Baseline MCP tool names and order must remain identical'
  );

  for (let i = 0; i < previousTools.length; i += 1) {
    const prev = previousTools[i];
    const curr = currentTools[i];
    const prevSchema = prev.inputSchema || {};
    const currSchema = curr.inputSchema || {};

    assert.equal(currSchema.type, prevSchema.type, `${prev.name}: schema type changed`);
    assert.equal(
      currSchema.additionalProperties,
      prevSchema.additionalProperties,
      `${prev.name}: additionalProperties policy changed`
    );
    assert.deepEqual(
      currSchema.required || [],
      prevSchema.required || [],
      `${prev.name}: required parameters must not change for N-1 clients`
    );

    const prevProps = prevSchema.properties || {};
    const currProps = currSchema.properties || {};
    for (const [propName, prevProp] of Object.entries(prevProps)) {
      const currProp = currProps[propName];
      assert.ok(currProp, `${prev.name}: missing baseline property "${propName}"`);
      assert.equal(currProp.type, prevProp.type, `${prev.name}.${propName}: property type changed`);
      if (prevProp.minimum !== undefined) {
        assert.equal(currProp.minimum, prevProp.minimum, `${prev.name}.${propName}: minimum changed`);
      }
      if (prevProp.maximum !== undefined) {
        assert.equal(currProp.maximum, prevProp.maximum, `${prev.name}.${propName}: maximum changed`);
      }
      if (Array.isArray(prevProp.enum)) {
        assert.ok(Array.isArray(currProp.enum), `${prev.name}.${propName}: enum removed`);
        for (const allowed of prevProp.enum) {
          assert.ok(
            currProp.enum.includes(allowed),
            `${prev.name}.${propName}: baseline enum value "${allowed}" removed`
          );
        }
      }
    }
  }
}
