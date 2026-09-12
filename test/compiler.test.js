import test from "node:test";
import assert from "node:assert/strict";
import { compile, parse } from "../dist/index.js";

test("parses plain JSON as KSOT", () => {
  assert.deepEqual(parse('{"name":"test","number":10}'), { name: "test", number: 10 });
});

test("parses KSOT types and comments", () => {
  const source = `@ksot

@com comment
{
  "name": String: "test",
  "number": Int: 10,
  "enabled": Boolean: true,
  "color": Color: #FFD700,
  "version": Version: v26.4
}`;
  assert.deepEqual(parse(source), {
    name: "test",
    number: 10,
    enabled: true,
    color: "#FFD700",
    version: "v26.4"
  });
});

test("supports imports and interpolation", () => {
  const files = {
    "metadata.ksot": `@ksot
{
  "version": "1.2.3",
  "author": "Intense"
}`
  };
  const source = `@ksot
@imp { version, author } from "metadata.ksot"
$"version": "\${metadata.version}"`;
  assert.deepEqual(parse(source, { resolveImport: (path) => files[path] }), { version: "1.2.3" });
});

test("compile returns formatted JSON", () => {
  assert.equal(compile(`@ksot
{ "value": Int: 42 }`), '{\n  "value": 42\n}');
});
