"use strict";

const path = require("path");
const readline = require("readline/promises");
const { createUser, loadUsers, saveUsers } = require("./accounts");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "server", "data"));

function parseArguments(argv) {
  const options = { username: "", role: "", passwordStdin: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--username") {
      options.username = String(argv[index + 1] || "");
      index += 1;
    } else if (argument === "--admin") {
      if (options.role && options.role !== "admin") throw new Error("不能同时指定 --admin 和 --member");
      options.role = "admin";
    } else if (argument === "--member") {
      if (options.role && options.role !== "member") throw new Error("不能同时指定 --admin 和 --member");
      options.role = "member";
    } else if (argument === "--password-stdin") {
      options.passwordStdin = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

async function readUsername() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question("用户名：");
  } finally {
    prompt.close();
  }
}

function readHidden(promptText) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("当前终端不支持隐藏输入，请在 SSH 交互终端中运行"));
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const previousRawMode = Boolean(stdin.isRaw);
    let value = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(previousRawMode);
      stdin.pause();
    };

    const finish = result => {
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const fail = error => {
      cleanup();
      process.stdout.write("\n");
      reject(error);
    };

    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === "\u0003" || character === "\u0004") return fail(new Error("已取消创建账号"));
        if (character === "\r" || character === "\n") return finish(value);
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    process.stdout.write(promptText);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readPasswordFromStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const password = input.replace(/\r/g, "").split("\n")[0];
  if (!password) throw new Error("标准输入中没有密码");
  return password;
}

function printHelp() {
  console.log("用法：npm run user:add -- [--username NAME] [--admin|--member]");
  console.log("密码默认在交互终端中隐藏输入。首个账号始终为管理员，后续账号默认为普通成员。");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();

  const username = options.username || await readUsername();
  let password;
  if (options.passwordStdin) {
    password = await readPasswordFromStdin();
  } else {
    password = await readHidden("密码（输入时不会显示）：");
    const confirmation = await readHidden("再次输入密码：");
    if (password !== confirmation) throw new Error("两次输入的密码不一致");
  }

  const store = loadUsers(DATA_DIR);
  const user = createUser(store, { username, password }, options.role || undefined);
  saveUsers(DATA_DIR, store);
  console.log(`账号已创建：${user.username}`);
  console.log(`权限：${user.role === "admin" ? "管理员" : "普通成员"}`);
}

main().catch(error => {
  console.error(`创建失败：${error.message}`);
  process.exitCode = 1;
});
