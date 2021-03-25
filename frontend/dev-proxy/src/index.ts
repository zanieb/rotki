import fs from 'fs';
import * as http from 'http';
import { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { bodyParser, default as jsonServer } from 'json-server';
import { statistics } from '@/mocked-apis/statistics';
import { enableCors } from '@/setup';

const server = jsonServer.create();
const router = jsonServer.router('db.json');
const middlewares = jsonServer.defaults();

const port = process.env.PORT || 4243;
const backend = process.env.BACKEND || 'http://localhost:4242';
const componentsDir = process.env.PREMIUM_COMPONENT_DIR;

enableCors(server);

if (
  componentsDir &&
  fs.existsSync(componentsDir) &&
  fs.statSync(componentsDir).isDirectory()
) {
  console.info('Enabling statistics renderer support');
  statistics(server, componentsDir);
} else {
  console.warn(
    'PREMIUM_COMPONENT_DIR was not a valid directory, disabling statistics renderer support.'
  );
}

let mockedAsyncCalls = {};
if (fs.existsSync('async-mock.json')) {
  try {
    console.info('Loading mock data from async-mock.json');
    const buffer = fs.readFileSync('async-mock.json');
    mockedAsyncCalls = JSON.parse(buffer.toString());
  } catch (e) {
    console.error(e);
  }
} else {
  console.info(
    'async-mock.json doesnt exist. No async_query mocking is enabled'
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function manipulateResponse(res: Response, callback: (original: any) => any) {
  const _write = res.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.write = (chunk: any) => {
    const response = chunk.toString();
    try {
      const payload = JSON.stringify(callback(JSON.parse(response)));
      res.header('content-length', payload.length.toString());
      res.status(200);
      res.statusMessage = 'OK';
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      _write.call(res, payload);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };
}

let mockTaskId = 100000;
const mockAsync: {
  pending: number[];
  completed: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  taskResponses: { [task: number]: any };
} = {
  pending: [],
  completed: [],
  taskResponses: {},
};

const counter: { [url: string]: { [method: string]: number } } = {};

setInterval(() => {
  const pending = mockAsync.pending;
  const completed = mockAsync.completed;
  if (pending.length > 0) {
    console.log(`detected ${pending.length} pending tasks: ${pending}`);
  }

  while (pending.length > 0) {
    const task = pending.pop();
    if (task) {
      completed.push(task);
    }
  }

  if (completed.length > 0) {
    console.log(`detected ${completed.length} completed tasks: ${completed}`);
  }
}, 8000);

function handleTasksStatus(res: Response) {
  manipulateResponse(res, (data) => {
    const result = data.result;
    if (result.pending) {
      result.pending.push(...mockAsync.pending);
    } else {
      result.pending = mockAsync.pending;
    }

    if (result.completed) {
      result.completed.push(...mockAsync.completed);
    } else {
      result.completed = mockAsync.completed;
    }

    return data;
  });
}

function handleTaskRequest(url: string, tasks: string, res: Response) {
  const task = url.replace(tasks, '');
  try {
    const taskId = parseInt(task);
    if (isNaN(taskId)) {
      return;
    }
    if (mockAsync.completed.includes(taskId)) {
      const outcome = mockAsync.taskResponses[taskId];
      manipulateResponse(res, () => ({
        outcome: outcome,
        status: 'completed',
      }));
      delete mockAsync.taskResponses[taskId];
      const index = mockAsync.completed.indexOf(taskId);
      mockAsync.completed.splice(index, 1);
    } else if (mockAsync.pending.includes(taskId)) {
      manipulateResponse(res, () => ({
        outcome: null,
        status: 'pending',
      }));
    }
  } catch (e) {
    console.error(e);
  }
}

function increaseCounter(baseUrl: string, method: string) {
  if (!counter[baseUrl]) {
    counter[baseUrl] = { [method]: 1 };
  } else {
    if (!counter[baseUrl][method]) {
      counter[baseUrl][method] = 1;
    } else {
      counter[baseUrl][method] += 1;
    }
  }
}

function getCounter(baseUrl: string, method: string): number {
  return counter[baseUrl]?.[method] ?? 0;
}

function handleAsyncQuery(url: string, req: Request, res: Response) {
  const mockedUrls = Object.keys(mockedAsyncCalls);
  const baseUrl = url.split('?')[0];
  const index = mockedUrls.findIndex((value) => value.indexOf(baseUrl) >= 0);

  if (index < 0) {
    return;
  }
  increaseCounter(baseUrl, req.method);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const response = mockedAsyncCalls[mockedUrls[index]]?.[req.method];
  if (!response) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pendingResponse: any;
  if (Array.isArray(response)) {
    const number = getCounter(baseUrl, req.method) - 1;
    if (number < response.length) {
      pendingResponse = response[number];
    } else {
      pendingResponse = response[response.length - 1];
    }
  } else if (typeof response === 'object') {
    pendingResponse = response;
  } else {
    pendingResponse = {
      result: null,
      message: 'There is something wrong with this mock',
    };
  }

  const taskId = mockTaskId++;
  mockAsync.pending.push(taskId);
  mockAsync.taskResponses[taskId] = pendingResponse;
  manipulateResponse(res, () => ({
    result: {
      task_id: taskId,
    },
    message: '',
  }));
}

function isAsyncQuery(req: Request) {
  return (
    req.method !== 'GET' &&
    req.rawHeaders.findIndex(
      (h) => h.toLocaleLowerCase().indexOf('application/json') >= 0
    ) &&
    req.body &&
    req.body['async_query'] === true
  );
}

function onProxyRes(
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) {
  let handled = false;
  const url = req.url;
  const tasks = '/api/1/tasks/';
  if (url.indexOf('async_query') > 0) {
    handleAsyncQuery(url, req, res);
    handled = true;
  } else if (url === tasks) {
    handleTasksStatus(res);
    handled = true;
  } else if (url.startsWith(tasks)) {
    handleTaskRequest(url, tasks, res);
    handled = true;
  } else if (isAsyncQuery(req)) {
    handleAsyncQuery(url, req, res);
    handled = true;
  }

  if (handled) {
    console.info('Handled request:', req.method, req.url);
  }
}

server.use(bodyParser);
server.use(
  createProxyMiddleware({
    target: backend,
    onProxyRes,
  })
);
server.use(middlewares);
server.use(router);

server.listen(port, () => {
  console.log(`Proxy server is running at http://localhost:${port}`);
});
