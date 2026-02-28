# Jest 测试最佳实践

## 基本结构

```typescript
describe('功能名称', () => {
  beforeAll(() => {
    // 初始化
  });

  afterAll(() => {
    // 清理
  });

  test('测试用例描述', () => {
    expect(actual).toBe(expected);
  });
});
```

## 常用断言

- `expect(value).toBe(expected)` - 精确匹配
- `expect(value).toEqual(expected)` - 深度匹配
- `expect(value).toBeNull()` - 检查 null
- `expect(value).toBeTruthy()` - 检查真值
- `expect(() => {}).toThrow()` - 检查抛出异常
- `expect(array).toContain(item)` - 检查包含元素

## Mock

```typescript
jest.mock('./module', () => ({
  function: jest.fn()
}));
```

## 异步测试

```typescript
test('async', async () => {
  const result = await fetchData();
  expect(result).toBeDefined();
});
```
