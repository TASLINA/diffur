/*
 * parser.js — превращает текст уравнения в:
 *   • нормализованное дерево math.js (для проверки и численного fallback),
 *   • исходник выражения для SymPy,
 *   • TeX для предпросмотра.
 *
 * Поддерживается: y' = f(x, y), y'' = f(x, y, y'), dy/dx = ..., d2y/dx2 = ...
 * и неявная запись вида y'' + 4y = 0 (уравнение разрешается относительно
 * старшей производной, если оно линейно по ней).
 */

const FUNCTION_ARITY = {
  sin: 1, cos: 1, tan: 1, cot: 1, sec: 1, csc: 1,
  asin: 1, acos: 1, atan: 1, atan2: 2,
  sinh: 1, cosh: 1, tanh: 1, asinh: 1, acosh: 1, atanh: 1,
  exp: 1, ln: 1, log: 1, log10: 1, lg: 1, sqrt: 1,
  abs: 1, sign: 1, floor: 1, ceil: 1, min: 2, max: 2,
  mod: 2, gamma: 1, erf: 1,
};

const ALLOWED_SYMBOLS = new Set([
  'x', 'y', 'D1', 'D2', 'pi', 'e', 'E', 'tau', 'Infinity',
]);

const MAX_ORDER = 2;

export class ParseError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'ParseError';
    this.detail = detail;
  }
}

function mathlib() {
  if (typeof window === 'undefined' || !window.math) {
    throw new ParseError('Математическая библиотека ещё загружается. Подождите секунду и попробуйте снова.');
  }
  return window.math;
}

/** Приводит пользовательскую запись к единому виду. */
export function normalizeInput(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // Юникодные типографские символы
  s = s.replace(/[′’‘ʹ`´]/g, "'");
  s = s.replace(/″/g, "''");
  s = s.replace(/[−–—]/g, '-');
  s = s.replace(/[×·⋅∙]/g, '*');
  s = s.replace(/÷/g, '/');
  s = s.replace(/π/g, 'pi');
  s = s.replace(/∞/g, 'Infinity');
  s = s.replace(/√\s*\(/g, 'sqrt(');
  s = s.replace(/√\s*([A-Za-z0-9.]+)/g, 'sqrt($1)');
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (ch) => `^${'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(ch)}`);

  // Производные в записи Лейбница
  s = s.replace(/d\s*\^\s*2\s*y\s*\/\s*d\s*x\s*\^\s*2/gi, "y''");
  s = s.replace(/d\s*2\s*y\s*\/\s*d\s*x\s*2/gi, "y''");
  s = s.replace(/d\s*y\s*\/\s*d\s*x/gi, "y'");

  // y''(x) → y'', y(x) → y
  s = s.replace(/\by\s*('+)\s*\(\s*x\s*\)/g, 'y$1');
  s = s.replace(/\by\s*\(\s*x\s*\)/g, 'y');

  // xy → x*y (только комбинации x и y, чтобы не ломать имена функций)
  s = s.replace(/\b([xy]{2,})\b/g, (m) => m.split('').join('*'));

  return s.replace(/\s+/g, ' ').trim();
}

function splitEquation(text) {
  let depth = 0;
  let index = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '=' && depth === 0) {
      if (index !== -1) {
        throw new ParseError('В уравнении больше одного знака «=». Поддерживается одно уравнение.');
      }
      index = i;
    }
  }
  if (index === -1) {
    throw new ParseError('Не найден знак «=». Пример: y\u2032 = x - y');
  }
  const lhs = text.slice(0, index).trim();
  const rhs = text.slice(index + 1).trim();
  if (!lhs) throw new ParseError('Левая часть уравнения пуста.');
  if (!rhs) throw new ParseError('Правая часть уравнения пуста.');
  return { lhs, rhs };
}

function detectOrder(text) {
  if (/y\s*'{3,}/.test(text)) {
    throw new ParseError('Поддерживаются уравнения не выше второго порядка.');
  }
  if (/y\s*''/.test(text)) return 2;
  if (/y\s*'/.test(text)) return 1;
  return 0;
}

function maskDerivatives(text) {
  return text
    .replace(/y\s*''/g, ' D2 ')
    .replace(/y\s*'/g, ' D1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNode(text, sideLabel) {
  const math = mathlib();
  try {
    return math.parse(text);
  } catch (error) {
    const detail = String(error?.message || error || '').replace(/\s+/g, ' ');
    throw new ParseError(
      `Не удалось разобрать ${sideLabel} уравнения.`,
      detail ? `Проверьте скобки и знаки операций. ${detail}` : 'Проверьте скобки и знаки операций.',
    );
  }
}

function validateNode(node) {
  // math.js обходит FunctionNode вместе с её SymbolNode-именем, поэтому
  // сначала запоминаем такие имена и не считаем их обычными переменными.
  const functionNames = new Set();
  node.traverse((n) => {
    if (n.isFunctionNode && n.fn) functionNames.add(n.fn);
  });

  let problem = null;
  node.traverse((n) => {
    if (problem) return;
    if (n.isSymbolNode && !functionNames.has(n) && !ALLOWED_SYMBOLS.has(n.name)) {
      problem = new ParseError(
        `Неизвестная переменная «${n.name}».`,
        'Поддерживаются переменные x (независимая) и y (искомая функция).',
      );
      return;
    }
    if (n.isFunctionNode) {
      const name = n.fn?.name;
      if (!name || !FUNCTION_ARITY[name]) {
        problem = new ParseError(
          `Неизвестная функция «${name || '?'}».`,
          'Доступны: sin, cos, tan, exp, ln, log, sqrt, abs, sinh, cosh, tanh и другие.',
        );
        return;
      }
      const expected = FUNCTION_ARITY[name];
      const actual = n.args?.length ?? 0;
      if (actual !== expected) {
        problem = new ParseError(
          `Функция «${name}» должна принимать ${expected} ${expected === 1 ? 'аргумент' : 'аргумента'}.`,
          `Сейчас передано: ${actual}.`,
        );
      }
      return;
    }
    if (n.isAssignmentNode || n.isFunctionAssignmentNode || n.isBlockNode) {
      problem = new ParseError('Присваивания и блоки команд не поддерживаются.');
      return;
    }
    if (n.isOperatorNode) {
      const known = new Set([
        'add', 'subtract', 'multiply', 'divide', 'pow', 'unaryMinus',
        'unaryPlus', 'mod', 'factorial',
      ]);
      if (!known.has(n.fn)) {
        problem = new ParseError(`Неподдерживаемая операция «${n.op || n.fn}».`);
      }
    }
  });
  if (problem) throw problem;
  return node;
}

function containsSymbol(node, name) {
  let found = false;
  node.traverse((n) => {
    if (n.isSymbolNode && n.name === name) found = true;
  });
  return found;
}

function isZeroNode(node) {
  return Boolean(node?.isConstantNode && Number(node.value) === 0);
}

/** Разрешает уравнение F = 0 относительно старшей производной. */
function isolateDerivative(F, order) {
  const math = mathlib();
  const dname = order === 2 ? 'D2' : 'D1';
  const pretty = order === 2 ? 'y\u2033' : 'y\u2032';

  let A;
  try {
    A = math.simplify(math.derivative(F, dname));
  } catch (error) {
    throw new ParseError(
      `Не удалось разрешить уравнение относительно ${pretty}.`,
      String(error?.message || error),
    );
  }

  if (containsSymbol(A, dname)) {
    throw new ParseError(
      `Уравнение нелинейно относительно ${pretty}.`,
      `Приведите его к явному виду: ${pretty} = f(${order === 2 ? 'x, y, y\u2032' : 'x, y'}).`,
    );
  }
  if (isZeroNode(A)) {
    throw new ParseError(
      `Не удалось выделить ${pretty}.`,
      'Проверьте, что производная действительно входит в уравнение.',
    );
  }

  let B;
  try {
    const zeroed = F.transform((n) => (
      n.isSymbolNode && n.name === dname ? new math.ConstantNode(0) : n
    ));
    B = math.simplify(zeroed);
  } catch {
    B = new math.ConstantNode(0);
  }

  const negativeB = new math.OperatorNode('-', 'unaryMinus', [B]);
  const ratio = new math.OperatorNode('/', 'divide', [negativeB, A]);
  try {
    return math.simplify(ratio);
  } catch {
    return ratio;
  }
}

/** Генерирует исходник выражения на Python/SymPy. */
function emitPython(node, mode) {
  const math = mathlib();
  const num = mode === 'numeric';
  const walk = (n) => {
    if (n.isConstantNode) {
      if (typeof n.value === 'number') {
        if (!Number.isFinite(n.value)) throw new ParseError('Бесконечные константы не поддерживаются.');
        return String(n.value);
      }
      throw new ParseError('Неподдерживаемая константа.');
    }
    if (n.isSymbolNode) {
      switch (n.name) {
        case 'e': return 'E';
        case 'tau': return '(2 * pi)';
        case 'Infinity': return 'oo';
        case 'D1': return num ? 'd1' : 'D1';
        case 'D2': return num ? 'd2' : 'D2';
        default: return n.name;
      }
    }
    if (n.isParenthesisNode) return `(${walk(n.content)})`;
    if (n.isOperatorNode) {
      const args = (n.args || []).map(walk);
      switch (n.fn) {
        case 'add': return `(${args[0]} + ${args[1]})`;
        case 'subtract': return `(${args[0]} - ${args[1]})`;
        case 'multiply': return `(${args[0]} * ${args[1]})`;
        case 'divide': return `(${args[0]} / ${args[1]})`;
        case 'pow': return `(${args[0]}) ** (${args[1]})`;
        case 'unaryMinus': return `(-${args[0]})`;
        case 'unaryPlus': return `(${args[0]})`;
        case 'mod': return `Mod(${args[0]}, ${args[1]})`;
        case 'factorial': return `factorial(${args[0]})`;
        default: throw new ParseError(`Неподдерживаемая операция «${n.fn}».`);
      }
    }
    if (n.isFunctionNode) {
      const name = n.fn?.name;
      const args = (n.args || []).map(walk);
      switch (name) {
        case 'ln':
        case 'log':
          return `log(${args[0]})`;
        case 'log10':
        case 'lg':
          return `log(${args[0]}, 10)`;
        case 'abs':
          return `Abs(${args[0]})`;
        case 'ceil':
          return `ceiling(${args[0]})`;
        case 'min':
          return `Min(${args.join(', ')})`;
        case 'max':
          return `Max(${args.join(', ')})`;
        case 'mod':
          return `Mod(${args.join(', ')})`;
        default:
          return `${name}(${args.join(', ')})`;
      }
    }
    throw new ParseError('В уравнении есть неподдерживаемая конструкция.');
  };
  return walk(node);
}

function nodeToTex(node) {
  let tex = '';
  try {
    tex = node.toTex({ parenthesis: 'keep', implicit: 'hide' });
  } catch {
    tex = node.toTex();
  }
  return tex
    .replace(/\\mathrm\{D1\}/g, "y'")
    .replace(/\\mathrm\{D2\}/g, "y''");
}

function compileNode(node) {
  const math = mathlib();
  const compiled = node.compile();
  return (x, y, d1 = 0, d2 = 0) => {
    let value;
    try {
      value = compiled.evaluate({ x, y, D1: d1, D2: d2 });
    } catch {
      return NaN;
    }
    if (typeof value === 'number') return value;
    if (value && typeof value.re === 'number' && Math.abs(value.im || 0) < 1e-12) {
      return value.re;
    }
    return NaN;
  };
}

/**
 * @param {string} raw
 * @returns {{
 *   raw: string, cleaned: string, order: number,
 *   rhsNode: any, rhsSympy: string, rhsNumeric: string,
 *   rhsTex: string, equationTex: string, lhsTex: string,
 *   rhsText: string, evaluate: (x:number,y:number,d1?:number,d2?:number)=>number
 * }}
 */
export function parseEquation(raw) {
  const cleaned = normalizeInput(raw);
  if (!cleaned) throw new ParseError('Введите уравнение.');

  const { lhs, rhs } = splitEquation(cleaned);
  const order = detectOrder(`${lhs} = ${rhs}`);
  if (order === 0) {
    throw new ParseError(
      'В уравнении нет производной.',
      'Это не дифференциальное уравнение. Пример: y\u2032 = x - y.',
    );
  }
  if (order > MAX_ORDER) {
    throw new ParseError('Поддерживаются уравнения не выше второго порядка.');
  }

  const lhsNode = validateNode(parseNode(maskDerivatives(lhs), 'левую часть'));
  const rhsNode = validateNode(parseNode(maskDerivatives(rhs), 'правую часть'));

  const math = mathlib();
  const F = new math.OperatorNode('-', 'subtract', [lhsNode, rhsNode]);
  const rhsSolved = isolateDerivative(F, order);

  // Убеждаемся, что в правой части не осталось старшей производной
  const dname = order === 2 ? 'D2' : 'D1';
  if (containsSymbol(rhsSolved, dname)) {
    throw new ParseError(
      'Не удалось выразить старшую производную через остальные величины.',
      'Уравнение нелинейно по старшей производной. Приведите его к явному виду.',
    );
  }

  const rhsSympy = emitPython(rhsSolved, 'sympy');
  const rhsNumeric = emitPython(rhsSolved, 'numeric');
  const rhsTex = nodeToTex(rhsSolved);
  const lhsTex = order === 2 ? '\\frac{d^{2}y}{dx^{2}}' : '\\frac{dy}{dx}';

  return {
    raw: String(raw),
    cleaned: `${lhs} = ${rhs}`,
    order,
    rhsNode: rhsSolved,
    rhsSympy,
    rhsNumeric,
    rhsTex,
    equationTex: `${lhsTex} = ${rhsTex}`,
    rhsText: rhsSolved.toString(),
    evaluate: compileNode(rhsSolved),
  };
}
