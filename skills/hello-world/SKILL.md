# hello-world

**Type:** Example / smoke-test
**Tools:** `hello_world`

## What it does

Returns a greeting string to confirm the Skills system loaded correctly.
Use this to verify a new deployment has the Skills system active.

## Tools

### `hello_world`

| Parameter | Type   | Required | Description                        |
|-----------|--------|----------|------------------------------------|
| `name`    | string | No       | Optional name to include in reply  |

**Returns:** `"Hello from the Skills system! 🎉"` (or with name if provided)

## Example

User: "test hello world skill"
Agent calls: `hello_world({})`
Result: `Hello from the Skills system! 🎉`
