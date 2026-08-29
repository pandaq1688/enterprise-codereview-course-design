#include <cstdio>
#include <cstring>

// 简单字符串工具：将输入复制到输出缓冲区
int copyString(const char* input, char* output, std::size_t outSize) {
    if (input == nullptr || output == nullptr || outSize == 0) {
        return -1;
    }
    std::strncpy(output, input, outSize - 1);
    output[outSize - 1] = '\0';
    return 0;
}

// 演示：未校验指针即解引用（明显缺陷，供 AC-09 审查验证）
int parseCount(const char* text) {
    // BUG: text 可能为 nullptr，此处直接 *text 导致空指针解引用
    if (*text == '\0') {
        return 0;
    }
    return static_cast<int>(std::strlen(text));
}

int main() {
    char* untrusted = nullptr;  // 模拟外部输入未校验
    int n = parseCount(untrusted);  // 传入 nullptr → 空指针解引用
    std::printf("count=%d\n", n);

    char buf[32];
    copyString("hello", buf, sizeof(buf));
    std::printf("copied=%s\n", buf);
    return 0;
}
