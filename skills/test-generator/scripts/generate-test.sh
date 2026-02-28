#!/bin/bash

# 测试生成脚本
# 用法: ./generate-test.sh <源文件> <测试框架>

SOURCE_FILE=$1
FRAMEWORK=${2:-jest}

if [ -z "$SOURCE_FILE" ]; then
  echo "用法: $0 <源文件> [测试框架]"
  echo "示例: $0 src/utils.ts jest"
  exit 1
fi

echo "为 $SOURCE_FILE 生成测试..."

# 解析源文件中的函数
FUNCTIONS=$(grep -E "^export (function|const|class)" "$SOURCE_FILE" | sed 's/export //' | awk '{print $2}' | cut -d'(' -f1)

echo "检测到的导出:"
echo "$FUNCTIONS"

# 生成测试文件
TEST_FILE=$(echo "$SOURCE_FILE" | sed 's/\.ts$/.test.ts/' | sed 's/src/__tests__/')

echo "测试文件: $TEST_FILE"

# 创建目录
mkdir -p "$(dirname "$TEST_FILE")"

# 生成测试代码
cat > "$TEST_FILE" << EOF
// Auto-generated test file
// Source: $SOURCE_FILE

import { } from '../$(basename "$SOURCE_FILE" .ts)';

describe('$(basename "$SOURCE_FILE" .ts)', () => {
  beforeEach(() => {
    // Setup
  });

  // Add your tests here
});
EOF

echo "测试文件已生成: $TEST_FILE"
