# Recording script for docs/demo.gif — run with https://github.com/charmbracelet/vhs
#
# Setup, once:
#   1. node scripts/seed-demo-budget.mjs   (creates the "Demo Budget" file)
#   2. mkdir demo && cd demo, then write .mcp.json pointing this server at the
#      demo budget's SYNC ID (the groupId the seed script prints), plus a
#      settings.json of {"language":"English"} and the run-claude.sh below.
#   3. vhs ../docs/demo.tape
#
# The recording drives a real session, so the answers differ every take. Two
# or three takes is normal; the Sleep values below are sized for the demo
# budget, not for a large one.
Output demo.gif
Set Shell "bash"
Set FontSize 16
Set Width 1360
Set Height 720
Set Padding 20
Set WindowBar Colorful
Set TypingSpeed 50ms
Set PlaybackSpeed 1.4

Hide
Type "clear"
Enter
Sleep 1s
Type "./run-claude.sh"
Enter
Sleep 10s
Down
Enter
Sleep 18s
Show

Type "Where did my money go in July?"
Sleep 1s
Enter
Sleep 30s

Type "Delete the Netflix charge from July"
Sleep 1s
Enter
Sleep 28s
