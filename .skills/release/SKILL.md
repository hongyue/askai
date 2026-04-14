---
name: release
description: Bump version, commit, tag, and push for askai project
trigger: "release" or "release <version>"
---

# Release Skill

Bump version, commit, tag, and push for the askai project.

## Steps

### 1. Determine new version
- If user provides a version (x.y.z), use it
- If user does NOT provide a version, increment the `z` patch number
- Read current version from `package.json`

### 2. Update package.json and package-lock.json
- Parse both files
- Set `version` field to the new version
- Write both files back

### 3. Git commit
```
git add package.json package-lock.json
git commit -m "release: v{new_version}"
```

### 4. Create git tag
```
git tag -a "v{new_version}" -m "release: v{new_version}"
```

### 5. Push code and tag
```
git push origin main
git push origin "v{new_version}"
```

## Verification
- `git log --oneline -3` shows the release commit
- `git tag | grep "v{new_version}"` confirms the tag exists
