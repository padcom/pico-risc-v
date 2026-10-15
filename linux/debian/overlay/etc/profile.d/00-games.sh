# Games (Freedoom, Chocolate Doom) are in /usr/games: root's PATH too.
# (Before desktop.sh, which starts X: its programs get it.)
case ":$PATH:" in
  *:/usr/games:*) ;;
  *) PATH=$PATH:/usr/games ;;
esac
