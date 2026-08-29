/**
 * 示例 Java 类：根据需求文档对字符串做简单规范化。
 */
public class Demo {

    /**
     * 将输入 trim 并转为小写；null 或空白输入返回空字符串。
     */
    public static String normalize(String input) {
        if (input == null) {
            return "";
        }
        String trimmed = input.trim();
        if (trimmed.isEmpty()) {
            return "";
        }
        return trimmed.toLowerCase();
    }

    public static void main(String[] args) {
        System.out.println(normalize("  Hello World  "));
    }
}
