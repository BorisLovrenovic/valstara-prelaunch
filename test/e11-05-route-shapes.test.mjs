import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseAstro } from '@astrojs/compiler';
import ts from 'typescript';
import { adminRouteRegistry } from '../src/server/admin-auth/route-registry.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const apiRoot = `${root}/src/pages/api`;
const pagesRoot = `${root}/src/pages`;
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

const personalValue =
  /\b(?:clientAddress|rawEmail|email|emailNormalised|ipAddress|subscriber)\b|\.(?:email|email_normalised|ip|token_hash)\b/u;

function responseTaints(source) {
  const declarations = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      declarations.push([node.name.text, node.initializer.getText(source)]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const tainted = new Set();
  let changed;
  do {
    changed = false;
    for (const [name, expression] of declarations) {
      if (tainted.has(name)) continue;
      if (
        personalValue.test(expression) ||
        [...tainted].some((alias) =>
          new RegExp(`(?<!\\.)\\b${alias}\\b`, 'u').test(expression),
        )
      ) {
        tainted.add(name);
        changed = true;
      }
    }
  } while (changed);
  return tainted;
}

function assertSafeValue(value, source, path, tainted) {
  const text = value.getText(source);
  assert.doesNotMatch(
    text,
    personalValue,
    `${path} serializes a personal response value: ${text}`,
  );
  for (const alias of tainted)
    assert.doesNotMatch(
      text,
      new RegExp(`(?<!\\.)\\b${alias}\\b`, 'u'),
      `${path} serializes a personal response value via ${alias}`,
    );
}

function responseObjectFields(source, path) {
  const bodies = [];
  const tainted = responseTaints(source);
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
        for (const property of body.properties) {
          if (ts.isPropertyAssignment(property))
            assertSafeValue(property.initializer, source, path, tainted);
          if (ts.isShorthandPropertyAssignment(property))
            assertSafeValue(property.name, source, path, tainted);
        }
      }
      if (expression === 'Response.json' || expression === 'JSON.stringify') {
        const body = node.arguments[0];
        if (body && ts.isObjectLiteralExpression(body)) {
          bodies.push(objectFields(body));
          for (const property of body.properties) {
            if (ts.isPropertyAssignment(property))
              assertSafeValue(property.initializer, source, path, tainted);
            if (ts.isShorthandPropertyAssignment(property))
              assertSafeValue(property.name, source, path, tainted);
          }
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

async function astroResponseShape(path) {
  const text = await readFile(`${pagesRoot}/${path}`, 'utf8');
  const { ast } = await parseAstro(text);
  const frontmatter = ast.children.find((node) => node.type === 'frontmatter');
  assert.ok(frontmatter, `${path} has no inspectable frontmatter`);
  const source = ts.createSourceFile(
    path,
    frontmatter.value,
    ts.ScriptTarget.Latest,
    true,
  );
  const methods = ['GET'];
  if (/Astro\.request\.method\s*===\s*['"]POST['"]/u.test(frontmatter.value))
    methods.push('POST');
  const personalAliases = new Set(['clientAddress', ...responseTaints(source)]);
  const rendered = [];
  const visitMarkup = (node) => {
    if (node.type === 'expression')
      rendered.push(node.children.map((child) => child.value ?? '').join(''));
    for (const attribute of node.attributes ?? []) {
      if (attribute.kind === 'expression' || attribute.kind === 'spread')
        rendered.push(attribute.value);
    }
    for (const child of node.children ?? []) visitMarkup(child);
  };
  for (const child of ast.children) {
    if (child !== frontmatter) visitMarkup(child);
  }
  for (const expression of rendered) {
    if (!(path === 'dsr.astro' && expression.trim() === 'dsrCopy.email'))
      assert.doesNotMatch(
        expression,
        personalValue,
        `${path} renders a personal response value`,
      );
    for (const alias of personalAliases) {
      assert.doesNotMatch(
        expression,
        new RegExp(`(?<!\\.)\\b${alias}\\b`, 'u'),
        `${path} renders a personal value via ${alias}`,
      );
    }
  }
  return methods;
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
  const astroFiles = (await readdir(pagesRoot, { recursive: true }))
    .filter((path) => path.endsWith('.astro'))
    .sort();
  for (const path of astroFiles) {
    inventory.push({ path, methods: await astroResponseShape(path) });
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
  assert.equal(inventory.length, files.length + astroFiles.length);
  assert.deepEqual(
    inventory
      .filter(
        (entry) =>
          entry.path.endsWith('.astro') && entry.methods.includes('POST'),
      )
      .map((entry) => entry.path),
    ['giveaway/award.astro', 'me.astro', 'unsubscribe.astro', 'verify.astro'],
  );
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
  assert.throws(
    () =>
      responseObjectFields(
        source('jsonResponse(200, { message: clientAddress });'),
        'signup.ts',
      ),
    /personal response value/u,
  );
  assert.throws(
    () =>
      responseObjectFields(
        source(
          'const leaked = clientAddress; jsonResponse(200, { message: leaked });',
        ),
        'signup.ts',
      ),
    /personal response value/u,
  );
});
