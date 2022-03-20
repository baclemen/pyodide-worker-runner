import {
  asyncSleep,
  Channel,
  makeAtomicsChannel,
  makeServiceWorkerChannel,
  ServiceWorkerError,
  writeMessage,
} from "sync-message";
import {OutputPart, PyodideClient} from "../lib";
import * as Comlink from "comlink";
import {isEqual} from "lodash";

const Worker = require("worker-loader!./worker").default;

async function runTests() {
  await navigator.serviceWorker.register("./sw.js");
  const serviceWorkerChannel = makeServiceWorkerChannel({timeout: 1000});
  try {
    await writeMessage(serviceWorkerChannel, "test", "foo");
  } catch (e) {
    if (e instanceof ServiceWorkerError) {
      window.location.reload();
    } else {
      throw e;
    }
  }

  const channels: Channel[] = [serviceWorkerChannel];
  const hasSAB = typeof SharedArrayBuffer !== "undefined";
  if (hasSAB) {
    channels.push(makeAtomicsChannel());
  }

  const client = new PyodideClient(() => new Worker());
  const testResults: any[] = [];
  let test = "";
  let channelType = "";
  let resultPromise: Promise<any>;
  let output = "";
  let prompt = "";

  function runCode(code: string) {
    prompt = "none";
    output = "";
    resultPromise = client.call(
      client.workerProxy.test,
      code,
      Comlink.proxy(inputCallback),
      Comlink.proxy(outputCallback),
    );
  }

  async function expect(expected: any) {
    const result = await resultPromise;
    await asyncSleep(100);
    const actual = {result, output, prompt};
    const passed = isEqual(actual, expected);
    console.log(output);
    testResults.push({
      test,
      actual,
      expected,
      passed,
      channelType,
    });
  }

  function outputCallback(parts: OutputPart[]) {
    for (const part of parts) {
      output += `${part.type}:${part.text};`;
    }
  }

  function inputCallback(p: string) {
    prompt = p;
  }

  for (const channel of channels) {
    channelType = channel.type;
    client.channel = channel;

    let test = "test_print";
    runCode("print(123)");

    await expect({
      result: "success",
      prompt: "none",
      output: "stdout:123\n;",
    });

    test = "test_input";
    runCode("print(int(input('hi')))");
    await asyncSleep(100);
    await client.writeMessage("456");
    await expect({
      result: "success",
      prompt: "hi",
      output: `input_prompt:hi;input:456
;stdout:456;stdout:
;`,
    });

    test = "test_interrupt_input";
    runCode(
      `
try:
  input('interrupt me')
except BaseException as e:
  print(type(e).__name__)
else:
  print('not!')
`,
    );
    await asyncSleep(100);
    await client.interrupt();
    await expect({
      result: "success",
      prompt: "interrupt me",
      output: `input_prompt:interrupt me;stdout:KeyboardInterrupt
;`,
    });

    test = "test_sleep";
    runCode(
      `
import time
start = time.time()
time.sleep(1)
end = time.time()
print(1 < end - start < 1.5)
`,
    );
    await expect({
      result: "success",
      prompt: "none",
      output: "stdout:True;stdout:\n;",
    });

    test = "test_interrupt_sleep";
    runCode(
      `
import time
start = time.time()
try:
  time.sleep(2)
except BaseException as e:
  print(type(e).__name__)
else:
  print('not!')
end = time.time()
print(end - start < 0.5)
`,
    );
    await asyncSleep(100);
    await client.interrupt();
    await expect({
      result: "success",
      prompt: "none",
      output: `stdout:KeyboardInterrupt
True
;`,
    });
  }

  test = "test_no_channel";
  client.channel = null;
  runCode(
    `
try:
  input('no channel')
except BaseException as e:
  print(e)
else:
  print('not!')
`,
  );
  await expect({
    result: "success",
    prompt: "no channel",
    output:
      "input_prompt:no channel;" +
      "stdout:This browser doesn't support reading input. " +
      "Try upgrading to the most recent version or switching to a different browser, " +
      "e.g. Chrome or Firefox.\n;",
  });

  test = "test_service_worker_error";
  client.channel = {...serviceWorkerChannel, baseUrl: window.location.href};
  runCode(
    `
try:
  input('no service worker')
except BaseException as e:
  print(e)
else:
  print('not!')
`,
  );
  await expect({
    result: "success",
    prompt: "no service worker",
    output:
      "input_prompt:no service worker;" +
      "stdout:The service worker for reading input isn't working. " +
      "Try closing all this site's tabs, then reopening. " +
      "If that doesn't work, try using a different browser.;" +
      "stdout:\n;",
  });

  if (hasSAB) {
    test = "test_interrupt";
    runCode(
      `
try:
  while True:
    pass
except BaseException as e:
  print(type(e).__name__)
else:
  print('not!')
`,
    );
    await asyncSleep(100);
    await client.interrupt();
    await expect({
      result: "success",
      prompt: "none",
      output: "stdout:KeyboardInterrupt\n;",
    });
  }

  (window as any).testResults = testResults;
  console.log(testResults);

  let numPassed = testResults.filter((t) => t.passed).length;
  let numTotal = testResults.length;
  let finalResult = numPassed === numTotal ? "PASSED" : "FAILED";
  const body = document.getElementsByTagName("body")[0];
  body.innerHTML = `<div id=result>${numPassed} / ${numTotal} : ${finalResult}!</div>`;
}

runTests();
