import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('the verification survey submits inline without adding a fourth island', async () => {
  const [page, islands] = await Promise.all([
    readFile(new URL('../src/pages/verify.astro', import.meta.url), 'utf8'),
    readdir(new URL('../src/islands/', import.meta.url)),
  ]);

  assert.match(page, /action="\/api\/survey"/u);
  assert.match(page, /name="version"/u);
  assert.match(page, /event\.preventDefault\(\)/u);
  assert.match(page, /fetch\(surveyForm\.action/u);
  assert.match(page, /aria-live="polite"/u);
  assert.deepEqual(islands.filter((path) => path.endsWith('.astro')).sort(), [
    'Leaderboard.astro',
    'SignupForm.astro',
    'ThemeToggle.astro',
  ]);
  assert.doesNotMatch(page, /localStorage|sessionStorage|document\.cookie/u);
});

test('the inline enhancement prevents navigation and reports the same-page response', async () => {
  const page = await readFile(
    new URL('../src/pages/verify.astro', import.meta.url),
    'utf8',
  );
  const script = page.match(/<script is:inline>([\s\S]*?)<\/script>/u)?.[1];
  assert.notEqual(script, undefined);

  class Element {}
  class Button extends Element {
    disabled = false;
  }
  class Status extends Element {
    textContent = '';
  }
  const button = new Button();
  const status = new Status();
  let submitHandler;
  class Form extends Element {
    action = 'https://valstara.test/api/survey';
    dataset = { unavailableMessage: 'unavailable' };

    addEventListener(name, handler) {
      if (name === 'submit') submitHandler = handler;
    }

    querySelector(selector) {
      return selector === '[type="submit"]' ? button : status;
    }
  }
  const form = new Form();
  let fetchInput;
  vm.runInNewContext(script, {
    FormData: class {},
    HTMLButtonElement: Button,
    HTMLInputElement: class extends Element {},
    HTMLElement: Element,
    HTMLFormElement: Form,
    document: {
      querySelector: (selector) =>
        selector === '[data-survey-form]' ? form : null,
    },
    fetch: async (input) => {
      fetchInput = input;
      return {
        json: async () => ({ message: 'saved' }),
        ok: true,
      };
    },
  });

  let prevented = false;
  await submitHandler({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(fetchInput, form.action);
  assert.equal(status.textContent, 'saved');
  assert.equal(button.disabled, false);
});
