file_path = r"D:\Проекты\Мои проекты\QuestLog\static\style.css"

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

block_to_remove = ":root {\n  --radius-sm: 8px;\n  --radius-md: 14px;\n  --border-width: 1px;\n\n  --font: \"Segoe UI\", -apple-system, Roboto, Helvetica, Arial, sans-serif;\n  --font-display: Georgia, \"Times New Roman\", \"Palatino Linotype\", serif;\n}\n\n"

new_content = content.replace(block_to_remove, "")

with open(file_path, "w", encoding="utf-8") as f:
    f.write(new_content)

print("Replacement done")
