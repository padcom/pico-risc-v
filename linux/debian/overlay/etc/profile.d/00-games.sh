# Games (Freedoom, Chocolate Doom) are in /usr/games: root's PATH too.
# (Before desktop.sh, which starts X: its programs get it.)
case ":$PATH:" in
  *:/usr/games:*) ;;
  *) PATH=$PATH:/usr/games ;;
esac
# SDL shows a software-drawn window (Chocolate Doom's) through OpenGL when
# it can: here that's Mesa's llvmpipe, a GPU emulated on the harts, which
# takes most of them. X's shared memory instead: a tenth of the work.
export SDL_FRAMEBUFFER_ACCELERATION=0
