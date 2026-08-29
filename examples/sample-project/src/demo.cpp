#include <cctype>
#include <cstdio>
#include <string>

// 去除首尾空白（ASCII）
static std::string trimAscii(const std::string& s) {
    std::size_t start = 0;
    while (start < s.size() && std::isspace(static_cast<unsigned char>(s[start]))) {
        ++start;
    }
    std::size_t end = s.size();
    while (end > start && std::isspace(static_cast<unsigned char>(s[end - 1]))) {
        --end;
    }
    return s.substr(start, end - start);
}

// 将输入 trim 并转为小写；与 Demo.java / requirement.md 语义一致
std::string normalize(const char* input) {
    // BUG: input 可能为 nullptr，此处直接 *input 导致空指针解引用
    if (*input == '\0') {
        return "";
    }
    std::string trimmed = trimAscii(input);
    if (trimmed.empty()) {
        return "";
    }
    for (char& ch : trimmed) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return trimmed;
}

int main() {
    char* untrusted = nullptr;  // 模拟外部输入未校验
    std::string result = normalize(untrusted);  // 传入 nullptr → 空指针解引用
    std::printf("normalized=%s\n", result.c_str());

    std::printf("%s\n", normalize("  Hello World  ").c_str());
    return 0;
}
