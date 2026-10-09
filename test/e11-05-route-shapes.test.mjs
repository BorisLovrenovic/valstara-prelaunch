import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { adminRouteRegistry } from '../src/server/admin-auth/route-registry.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const apiRoot = `${root}/src/pages/api`;
const responseFields = new Set([
  'error',
  'code',
  'message',
  'status',
  'snapshot_id',
  'as_of',
  'entries',
  'confirmed_referrals',
  'display_handle',
  'rank',
]);
const delegatedDsrRoutes = new Set(['dsr/delete.ts', 'dsr/export.ts']);
const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function exportedMethods(source) {
  const methods = [];
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        httpMethods.has(declaration.name.text)
      ) {
        methods.push(declaration.name.text);
      }
    }
  }
  return methods.sort();
}

function objectFields(object) {
  const fields = new Set();
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const name = node.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name))
        fields.add(name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(object);
  return fields;
}

function responseObjectFields(source, path) {
  const bodies = [];
  let wrapperSerializations = 0;
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'Response'
    ) {
      const body = node.arguments?.[0];
      assert.ok(
        body &&
          (body.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isCallExpression(body) &&
              body.expression.getText(source) === 'JSON.stringify')),
        `${path} has an uninspected raw response body`,
      );
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      if (expression === 'json' || expression === 'jsonResponse') {
        const body = node.arguments[1];
        assert.ok(
          body && ts.isObjectLiteralExpression(body),
          `${path} has a dynamic JSON response body`,
        );
        bodies.push(objectFields(body));
      }
      if (expression === 'Response.json' || expression === 'JSON.stringify') {
        const body = node.arguments[0];
        if (body && ts.isObjectLiteralExpression(body)) {
          bodies.push(objectFields(body));
        } else {
          assert.ok(
            expression === 'JSON.stringify' &&
              body &&
              ts.isIdentifier(body) &&
              body.text === 'body',
            `${path} serializes an uninspected response value`,
          );
          wrapperSerializations += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(
    wrapperSerializations,
    path === 'webhooks/[provider].ts' ? 0 : 1,
    `${path} must have only its inspected JSON wrapper`,
  );
  return bodies;
}

test('E11-05 generates the registered API inventory and rejects personal fields in public response shapes', async () => {
  const files = (await readdir(apiRoot, { recursive: true }))
    .filter((path) => path.endsWith('.ts'))
    .sort();
  assert.ok(files.length > 0);
  const adminSources = adminRouteRegistry
    .map((entry) => entry.source.replace('src/pages/api/', ''))
    .sort();
  assert.deepEqual(
    files.filter((path) => path.startsWith('admin/')),
    adminSources,
    'every admin route must be in the authenticated registry',
  );
  const inventory = [];
  for (const path of files) {
    const text = await readFile(`${apiRoot}/${path}`, 'utf8');
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const methods = exportedMethods(source);
    assert.ok(methods.length > 0, `${path} has no registered method`);
    inventory.push({ path, methods });
    if (path.startsWith('admin/')) {
      const registered = adminRouteRegistry.find((entry) =>
        entry.source.endsWith(`/${path}`),
      );
      assert.deepEqual(
        methods,
        registered.methods.map((method) => method.method).sort(),
        `${path} method registry`,
      );
      continue;
    }
    if (delegatedDsrRoutes.has(path)) {
      assert.match(
        text,
        /handleDsr\(/u,
        `${path} must delegate to the subject-scoped DSR handler`,
      );
      continue;
    }
    const shapes = responseObjectFields(source, path);
    assert.ok(shapes.length > 0, `${path} has no inspectable response shape`);
    for (const fields of shapes) {
      for (const field of fields) {
        assert.ok(
          responseFields.has(field),
          `${path} publishes unapproved response field ${field}`,
        );
      }
    }
  }
  const dsrHandler = await readFile(`${root}/src/server/dsr/http.ts`, 'utf8');
  assert.match(
    dsrHandler,
    /consumeForPurpose\(token, `dsr_\$\{operation\}`\)/u,
    'DSR export must require its own purpose-bound bearer',
  );
  assert.match(
    dsrHandler,
    /exportSubject\(/u,
    'DSR export must use subject-scoped projection',
  );
  assert.equal(inventory.length, files.length);
});

test('E11-05 response-shape guard fails on personal, dynamic and raw response bodies', () => {
  const source = (body) =>
    ts.createSourceFile(
      'signup.ts',
      `function jsonResponse(status, body) { return new Response(JSON.stringify(body), { status }); }\n${body}`,
      ts.ScriptTarget.Latest,
      true,
    );
  const leaked = responseObjectFields(
    source('jsonResponse(200, { email: "visitor@example.test" });'),
    'signup.ts',
  );
  assert.ok(leaked.some((fields) => fields.has('email')));
  assert.throws(
    () =>
      responseObjectFields(
        source('jsonResponse(200, subscriber);'),
        'signup.ts',
      ),
    /dynamic JSON response body/u,
  );
  assert.throws(
    () =>
      responseObjectFields(
        source('new Response(subscriber.email);'),
        'signup.ts',
      ),
    /uninspected raw response body/u,
  );
});
