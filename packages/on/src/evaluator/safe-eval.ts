import * as acorn from 'acorn';

// Global built-in functions available in expressions
export const BUILTIN_HELPERS: Record<string, Function | object> = {
  String: (val: any) => String(val ?? ''),
  Number: (val: any) => Number(val),
  Boolean: (val: any) => Boolean(val),
  JSON: {
    parse: (str: string) => JSON.parse(str),
    stringify: (obj: any) => JSON.stringify(obj, null, 2),
  },
};

export class SafeExpressionEvaluator {
  /**
   * Evaluates an expression string asynchronously using safe AST traversal.
   * Handles both standalone expressions ("inputs.branch === 'main'")
   * and raw JS template expressions.
   */
  static async evaluateAsync(expression: string, context: Record<string, any> = {}): Promise<any> {
    if (!expression || typeof expression !== 'string') {
      return expression;
    }

    // Strip leading/trailing ${{ ... }} wrappers if present
    const cleanExpr =
      expression.trim().startsWith('${{') && expression.trim().endsWith('}}')
        ? expression.trim().slice(4, -2).trim()
        : expression.trim();

    const ast = acorn.parseExpressionAt(cleanExpr, 0, {
      ecmaVersion: 2020,
      allowAwaitOutsideFunction: false,
    });

    return this.evalNodeAsync(ast, context);
  }

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

      // Property Access: inputs.branch or inputs["clone_url"]
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

      // Function & Method Execution: slack_notify(...) or url.replace(...)
      case 'CallExpression': {
        let fn: Function | undefined;
        let targetObj: any = null;

        if (node.callee.type === 'MemberExpression') {
          targetObj = await this.evalNodeAsync(node.callee.object, ctx);
          const prop = node.callee.computed
            ? await this.evalNodeAsync(node.callee.property, ctx)
            : node.callee.property.name;

          // SECURITY GUARD: Block Invocation on Constructors/Prototypes
          if (['constructor', '__proto__', 'prototype'].includes(prop)) {
            throw new Error(`Security Guard Violation: Access to method '${prop}' is blocked.`);
          }

          if (targetObj != null && typeof targetObj[prop] === 'function') {
            fn = targetObj[prop];
          } else {
            throw new Error(`Property '${prop}' is not a callable function.`);
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

        // Evaluate argument expressions concurrently
        const args = await Promise.all(node.arguments.map((arg: any) => this.evalNodeAsync(arg, ctx)));

        // Execute function safely bound to target object context
        return await fn.apply(targetObj, args);
      }

      // Binary Operators: a == b, x + y, p > q
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

      // Template Strings: `Build ${inputs.branch}`
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

      default:
        throw new Error(`Security Guard Violation: AST Node type '${node.type}' is disallowed.`);
    }
  }

  /**
   * Synchronous helper wrapper for simple non-promise expressions.
   */
  static evaluate(expression: string, context: Record<string, any> = {}): any {
    // Note: If an async helper function is called inside, evaluateAsync should be used instead.
    let syncResult: any;
    let err: any;

    this.evaluateAsync(expression, context)
      .then((res) => {
        syncResult = res;
      })
      .catch((e) => {
        err = e;
      });

    if (err) throw err;
    return syncResult;
  }
}
