import { test } from "node:test";
import assert from "node:assert/strict";

import { detectLanguage, looksLikeCode, type SeedLanguage } from "./seed-format.ts";

const CODE: Array<[SeedLanguage, string]> = [
  [
    "Python",
    `import math
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

    def norm(self) -> float:
        return math.hypot(self.x, self.y)`,
  ],
  [
    "Python",
    `from build123d import *
import numpy as np

body_length = 6
leg_height = 2.4

with BuildPart() as unicorn:
    Box(body_length, 2.4, 2.4)
    with Locations((2, 0, 1.2)):
        Cylinder(0.6, 2.0)
    with Locations((-2, 0, 1.2)):
        Cylinder(0.6, 2.0)
    for x in (-1.5, 1.5):
        with Locations((x, 0, -leg_height / 2)):
            Cylinder(0.4, leg_height)
    Cone(0.3, 0.0, 1.5)

show(unicorn.part)`,
  ],
  ["Python", `#!/usr/bin/env python3\nprint("hi")`],
  [
    "TypeScript",
    `import { z } from "zod";

export const User = z.object({
  name: z.string(),
  age: z.number().int(),
});

export type User = z.infer<typeof User>;

export function greet(user: User): string {
  return \`hi \${user.name}\`;
}`,
  ],
  [
    "JavaScript",
    `const fs = require("fs");
const path = require("path");

function readConfig(dir) {
  const file = path.join(dir, "config.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

module.exports = { readConfig };`,
  ],
  [
    "JSX",
    `import { useState } from "react";

export default function Counter() {
  const [n, setN] = useState(0);
  return (
    <button className="counter" onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}`,
  ],
  ["JSON", `{\n  "name": "skynet",\n  "version": 1,\n  "tags": ["a", "b"]\n}`],
  [
    "JSON",
    `{
  "name": "skynet",
  "private": true,
  "scripts": {
    "dev": "next dev",
  },
}`,
  ],
  [
    "YAML",
    `services:
  api:
    image: skynet/api:latest
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://db/skynet
  db:
    image: postgres:16`,
  ],
  [
    "TOML",
    `[package]
name = "skynet"
version = "0.1.0"

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = "1"`,
  ],
  [
    "SQL",
    `SELECT u.id, u.name, count(o.id) AS orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.active = true
GROUP BY u.id, u.name
ORDER BY orders DESC
LIMIT 20;`,
  ],
  [
    "HTML",
    `<!DOCTYPE html>
<html lang="en">
  <head><title>Skynet</title></head>
  <body>
    <main class="app"><h1>Hello</h1></main>
  </body>
</html>`,
  ],
  [
    "XML",
    `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <server host="0.0.0.0" port="8000"/>
  <feature name="blackbox" enabled="true"/>
</config>`,
  ],
  [
    "CSS",
    `.card {
  padding: 12px 16px;
  border-radius: 8px;
}

.card:hover {
  background: var(--muted);
}`,
  ],
  [
    "Rust",
    `use std::fmt;

pub struct Point {
    x: f64,
    y: f64,
}

impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}`,
  ],
  [
    "Go",
    `package main

import "fmt"

func main() {
    for i := 0; i < 3; i++ {
        fmt.Println(i)
    }
}`,
  ],
  [
    "Java",
    `package app;

import java.util.List;

public class Main {
    public static void main(String[] args) {
        int total = 0;
        for (int i = 0; i < 3; i++) total += i;
        System.out.println(total);
    }
}`,
  ],
  [
    "C",
    `#include <stdio.h>

int main(void) {
    int n = 3;
    printf("%d\\n", n);
    return 0;
}`,
  ],
  [
    "C++",
    `#include <iostream>
#include <vector>

int main() {
    std::vector<int> xs = {1, 2, 3};
    for (auto x : xs) std::cout << x << "\\n";
    return 0;
}`,
  ],
  [
    "C#",
    `using System;

namespace App
{
    class Program
    {
        static void Main()
        {
            var total = 0;
            Console.WriteLine(total);
        }
    }
}`,
  ],
  [
    "Kotlin",
    `fun main() {
    val xs = listOf(1, 2, 3)
    for (x in xs) {
        println(x)
    }
}`,
  ],
  [
    "Swift",
    `import Foundation

struct Point {
    var x: Double
    var y: Double
}

let p = Point(x: 1, y: 2)
print(p)`,
  ],
  [
    "Ruby",
    `class Greeter
  def initialize(name)
    @name = name
  end

  def greet
    puts "Hello, #{@name}"
  end
end`,
  ],
  [
    "PHP",
    `<?php
$total = 0;
foreach ($items as $item) {
    $total += $item->price;
}
echo $total;`,
  ],
  [
    "Lua",
    `local M = {}

function M.greet(name)
  print("hi " .. name)
end

return M`,
  ],
  [
    "Shell",
    `set -euo pipefail
cd "$(dirname "$0")"
npm ci
npm run build
echo "done"`,
  ],
  ["Shell", `#!/usr/bin/env bash\nset -e\necho hi`],
  [
    "Dockerfile",
    `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
CMD ["python", "main.py"]`,
  ],
];

for (const [language, text] of CODE) {
  test(`detects ${language}`, () => {
    assert.equal(detectLanguage(text), language);
    assert.equal(looksLikeCode(text), true);
  });
}

const PROSE: Array<[string, string]> = [
  [
    "a prompt with a Rules: heading and bullets",
    `You are a careful assistant that rewrites product descriptions.

Rules:
- Keep the brand voice warm and direct.
- Never invent specifications.
- If the user asks for a discount, decline politely.

Return only the rewritten description.`,
  ],
  [
    "a bulleted prompt without full stops",
    `You are a support agent for Skynet
Rules:
- keep answers short
- never promise refunds
- escalate billing questions
Output:
- one paragraph`,
  ],
  [
    "a prompt that shows a JSON example",
    `Extract the fields below from the invoice text.
Respond with JSON only, shaped like this:
{
  "vendor": "string",
  "total": 0,
  "currency": "USD"
}
Do not add commentary.`,
  ],
  [
    "a markdown document",
    `# Release notes

## Fixed
- Crash when the seed is empty.
- Wrong label on the Kind picker.

## Added
- Syntax highlighting for pasted code.`,
  ],
  ["a list whose lines end in semicolons", `Deliverables:\nItem one;\nItem two;\nItem three;`],
  [
    "prose that opens lines with SQL words",
    `Where possible, keep the answer under 50 words.\nFrom the user's message, pick the main intent.\nSelect the closest matching article.`,
  ],
  [
    "a single assignment inside prose",
    `Set the temperature to 0.\ntemperature = 0.2\nThen explain.`,
  ],
  ["a one-liner", `print("hi")`],
  ["blank text", "  \n\n  "],
  ["empty text", ""],
];

for (const [name, text] of PROSE) {
  test(`leaves ${name} as text`, () => {
    assert.equal(detectLanguage(text), null);
    assert.equal(looksLikeCode(text), false);
  });
}

test("code the editor cannot name still counts as code", () => {
  const makefile = `build: deps\n\tgo build ./...\n\ndeps:\n\tgo mod download\n\nCC = gcc\nCFLAGS = -O2\nOUT = bin/app`;
  assert.equal(detectLanguage(makefile), null);
  assert.equal(looksLikeCode(makefile), true);
});
