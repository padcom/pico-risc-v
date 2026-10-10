/* Example user-space program, built into the image as /usr/local/bin/hello. */
#include <stdio.h>
#include <sys/utsname.h>

int main(int argc, char **argv) {
    struct utsname u;
    if (uname(&u) != 0) {
        perror("uname");
        return 1;
    }
    printf("Hello from %s %s on %s!\n", u.sysname, u.release, u.machine);
    for (int i = 1; i < argc; i++)
        printf("  argv[%d] = %s\n", i, argv[i]);
    return 0;
}
