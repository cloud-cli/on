import * as acorn from 'acorn';
import FS from 'node:fs';
import OS from 'node:os';
import Path from 'node:path';

export const BUILTIN_HELPERS: Record<string, any> = {
  String: (val: any) => String(val ?? ''),
  Number: (val: any) => Number(val),
  Boolean: (val: any) => Boolean(val),
  JSON: {
    parse: (str: string) => JSON.parse(str),
    stringify: (obj: any) => JSON.stringify(obj, null, 2),
  },
  FS: {
    readFile: (f) => FS.readFileSync(f, 'utf8'),
    exists: (f) => FS.existsSync(f),
    join: (...args) => Path.join(...args),
  },
  OS,
};

export class SafeExpressionEvaluator {
  /**
   * Deterministic Value Evaluator (Used for `env:`, `name:`, `image:`, `concurrency:`)
   * - Native non-string types (booleans, numbers, objects) pass through untouched.
   * - Strings WITHOUT `${` are returned as 100% literal strings (zero JS AST overhead).
   * - Strings WITH `${` are evaluated strictly as ES Template Literals.
   */
  static async evaluateValue(val: any, context: Record<string, any> = {}): Promise<any> {
    if (typeof val !== 'string') {
      return val;
    }

    // 1. Literal Passthrough: String does not contain `${`
    if (!val.includes('${')) {
      return val;
    }

    // 2. Dynamic Template Interpolation: Evaluates as ES Template Literal
    const templateExpr = `\`${val}\``;
    return this.evaluateExpression(templateExpr, context);
  }

  /**
   * Deterministic Condition Evaluator (Used for `if:`)
   * Strictly parses code as a JavaScript expression and coerces result to boolean.
   * Throws an explicit AST Parse Error on invalid syntax (fails fast and loud).
   */
  static async evaluateConditions(conditions: string | string[], context: Record<string, any> = {}): Promise<boolean> {
    if (typeof conditions === 'string') {
      conditions = [conditions];
    }

    for (const c of conditions) {
      const result = await this.evaluateExpression(c, context);
      
      if (process.env.DEBUG) {
        console.log('condition', result, c, context);
      }
      
      if (result) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluates direct JS code (Used for `eval:` steps or internal expression resolution).
   */
  static async evaluateExpression(code: string, context: Record<string, any> = {}): Promise<any> {
    if (!code || typeof code !== 'string') {
      return code;
    }

    const trimmed = code.trim();
    let ast: any;

    try {
      ast = acorn.parseExpressionAt(trimmed, 0, {
        ecmaVersion: 2020,
        allowAwaitOutsideFunction: false,
      });
    } catch (parseErr: any) {
      throw new Error(`Invalid expression syntax in '${trimmed}': ${parseErr.message}`);
    }

    return this.evalNodeAsync(ast, context);
  }

  /**
   * Asynchronous AST Node Walker with Security Guards
   */
  private static async evalNodeAsync(node: any, ctx: Record<string, any>): Promise<any> {
    switch (node.type) {
      // Primitive Literals: 123, "hello", true, null
      case 'Literal':
        return node.value;

      // Variables / Identifiers: inputs, steps, String
      case 'Identifier':
        if (node.name in ctx) return ctx[node.name];
        if (node.name in BUILTIN_HELPERS) return BUILTIN_HELPERS[node.name];
        return undefined;

      // Property Access: inputs.branch or secrets["TOKEN"]
      case 'MemberExpression': {
        const object = await this.evalNodeAsync(node.object, ctx);
        if (object == null) return undefined;

        const property = node.computed ? await this.evalNodeAsync(node.property, ctx) : node.property.name;

        // SECURITY GUARD: Block Prototype Pollution Escapes
        if (['constructor', '__proto__', 'prototype'].includes(property)) {
          throw new Error(`Security Guard Violation: Access to '${property}' is blocked.`);
        }

        return object[property];
      }

      // Function & Method Calls: slack_notify(...) or url.replace(...)
      case 'CallExpression': {
        let fn: Function | undefined;
        let targetObj: any = null;

        if (node.callee.type === 'MemberExpression') {
          targetObj = await this.evalNodeAsync(node.callee.object, ctx);
          const prop = node.callee.computed
            ? await this.evalNodeAsync(node.callee.property, ctx)
            : node.callee.property.name;

          if (['constructor', '__proto__', 'prototype'].includes(prop)) {
            throw new Error(`Security Guard Violation: Invoking method '${prop}' is blocked.`);
          }

          if (targetObj != null && typeof targetObj[prop] === 'function') {
            fn = targetObj[prop];
          } else {
            throw new Error(`Property '${prop}' is not a callable function on target object.`);
          }
        } else if (node.callee.type === 'Identifier') {
          const fnName = node.callee.name;
          fn = ctx[fnName] ?? BUILTIN_HELPERS[fnName];

          if (!fn || typeof fn !== 'function') {
            throw new Error(`Unknown function helper '${fnName}'.`);
          }
        }

        if (!fn) {
          throw new Error('Invalid function invocation target.');
        }

        const args = await Promise.all(node.arguments.map((arg: any) => this.evalNodeAsync(arg, ctx)));

        return await fn.apply(targetObj, args);
      }

      // Binary Operators: a === b, x + y, p > q
      case 'BinaryExpression': {
        const left = await this.evalNodeAsync(node.left, ctx);
        const right = await this.evalNodeAsync(node.right, ctx);

        switch (node.operator) {
          case '===':
          case '==':
            return left == right;
          case '!==':
          case '!=':
            return left != right;
          case '>':
            return left > right;
          case '<':
            return left < right;
          case '>=':
            return left >= right;
          case '<=':
            return left <= right;
          case '+':
            return left + right;
          case '-':
            return left - right;
          case '*':
            return left * right;
          case '/':
            return left / right;
          default:
            throw new Error(`Unsupported binary operator: ${node.operator}`);
        }
      }

      // Logical Operators: a && b, x || y
      case 'LogicalExpression': {
        const left = await this.evalNodeAsync(node.left, ctx);
        if (node.operator === '&&') {
          return left ? await this.evalNodeAsync(node.right, ctx) : left;
        }
        if (node.operator === '||') {
          return left ? left : await this.evalNodeAsync(node.right, ctx);
        }
        throw new Error(`Unsupported logical operator: ${node.operator}`);
      }

      // Unary Operators: !x, -y
      case 'UnaryExpression': {
        const argument = await this.evalNodeAsync(node.argument, ctx);
        if (node.operator === '!') return !argument;
        if (node.operator === '-') return -argument;
        if (node.operator === '+') return +argument;
        throw new Error(`Unsupported unary operator: ${node.operator}`);
      }

      // Template Strings: `node:${matrix.version}-alpine`
      case 'TemplateLiteral': {
        const quasis = node.quasis.map((q: any) => q.value.cooked);
        const expressions = await Promise.all(node.expressions.map((e: any) => this.evalNodeAsync(e, ctx)));

        let result = '';
        for (let i = 0; i < quasis.length; i++) {
          result += quasis[i];
          if (i < expressions.length) {
            result += expressions[i] ?? '';
          }
        }
        return result;
      }

      // Array Literals: [1, 2, "three"]
      case 'ArrayExpression': {
        return Promise.all(node.elements.map((elem: any) => this.evalNodeAsync(elem, ctx)));
      }

      // Object Literals: { a: 1, b: "hello" }
      case 'ObjectExpression': {
        const obj: Record<string, any> = {};
        for (const prop of node.properties) {
          if (prop.type === 'Property') {
            const key = prop.key.type === 'Identifier' ? prop.key.name : await this.evalNodeAsync(prop.key, ctx);
            obj[key] = await this.evalNodeAsync(prop.value, ctx);
          }
        }
        return obj;
      }

      // Optional Chaining: inputs?.repo
      case 'ChainExpression': {
        return this.evalNodeAsync(node.expression, ctx);
      }

      // Ternary operator
      case 'ConditionalExpression': {
        const test = await this.evalNodeAsync(node.test, ctx);
        return test ? await this.evalNodeAsync(node.consequent, ctx) : await this.evalNodeAsync(node.alternate, ctx);
      }

      default:
        throw new Error(`Security Guard Violation: AST Node type '${node.type}' is disallowed.`);
    }
  }
}
