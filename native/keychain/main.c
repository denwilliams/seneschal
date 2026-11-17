/* Host-only macOS helper. Protocol: operation/service/account argv (metadata),
 * raw UTF-8 value on stdin for save, raw value on stdout for read. Never log.
 * No unlock API, shell, network, plist, password or persistent plaintext. */
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#define __STDC_WANT_LIB_EXT1__ 1
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/resource.h>

/* macOS has no explicit_bzero; memset_s must not be optimised away. */
static void explicit_bzero(void *buffer, size_t length) { if (length) memset_s(buffer, length, 0, length); }

static int result(OSStatus status) {
    if (status == errSecSuccess) return 0;
    if (status == errSecItemNotFound) return 42;
    if (status == errSecAuthFailed || status == errSecUserCanceled || status == errSecReadOnly) return 43;
    if (status == errSecInteractionNotAllowed || status == errSecNotAvailable || status == errSecNoDefaultKeychain) return 44;
    return 45;
}
static int valid_route(const char *service, const char *account) {
    const char *prefix = "ai.slack-harness.keychain.v1.";
    if (strncmp(service, prefix, strlen(prefix)) != 0) return 0;
    const char *ns = service + strlen(prefix);
    if (!*ns || strlen(ns) > 64 || strspn(ns, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != strlen(ns)) return 0;
    const char *name;
    if (strncmp(account, "main-process/", 13) == 0) name = account + 13;
    else if (strncmp(account, "global-channel/", 15) == 0) name = account + 15;
    else if (strncmp(account, "channel/", 8) == 0) {
        const char *id = account + 8, *slash = strchr(id, '/');
        if (!slash || slash - id < 2 || slash - id > 128 || !strchr("CDG", *id)) return 0;
        if (strspn(id, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") != (size_t)(slash - id)) return 0;
        name = slash + 1;
    } else return 0;
    return *name >= 'A' && *name <= 'Z' && strlen(name) <= 128 && strspn(name, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") == strlen(name);
}
int main(int argc, char **argv) {
    struct rlimit no_core = {0, 0};
    setrlimit(RLIMIT_CORE, &no_core);
    if (argc != 4 || !valid_route(argv[2], argv[3])) return 45;
    int read_op = strcmp(argv[1], "read") == 0, save_op = strcmp(argv[1], "save") == 0, delete_op = strcmp(argv[1], "delete") == 0;
    if (!read_op && !save_op && !delete_op) return 45;
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 44;
    unsigned char value[16385] = {0};
    size_t size = 0;
    if (save_op) {
        size = fread(value, 1, sizeof(value), stdin);
        if (ferror(stdin) || !size || size > 16384 || memchr(value, 0, size)) { explicit_bzero(value, sizeof(value)); return 45; }
    }
    SecKeychainItemRef item = NULL;
    UInt32 length = 0;
    void *data = NULL;
    OSStatus status = SecKeychainFindGenericPassword(NULL, (UInt32)strlen(argv[2]), argv[2], (UInt32)strlen(argv[3]), argv[3], read_op ? &length : NULL, read_op ? &data : NULL, &item);
    if (read_op && status == errSecSuccess) {
        if (!length || length > 16384 || memchr(data, 0, length)) status = errSecParam;
        else if (fwrite(data, 1, length, stdout) != length || fflush(stdout) != 0) status = errSecIO;
    } else if (save_op && status == errSecSuccess) {
        status = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)size, value);
    } else if (save_op && status == errSecItemNotFound) {
        // Only this helper is trusted to read new items without a prompt. No "allow all applications" ACL.
        SecTrustedApplicationRef app = NULL;
        SecAccessRef access = NULL;
        CFArrayRef apps = NULL;
        status = SecTrustedApplicationCreateFromPath(NULL, &app);
        if (status == errSecSuccess) {
            apps = CFArrayCreate(NULL, (const void **)&app, 1, &kCFTypeArrayCallBacks);
            status = apps ? SecAccessCreate(CFSTR("Seneschal scoped secret"), apps, &access) : errSecAllocate;
        }
        if (status == errSecSuccess) {
            SecKeychainAttribute attrs[] = {
                { kSecServiceItemAttr, (UInt32)strlen(argv[2]), argv[2] },
                { kSecAccountItemAttr, (UInt32)strlen(argv[3]), argv[3] }
            };
            SecKeychainAttributeList list = { 2, attrs };
            status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list, (UInt32)size, value, NULL, access, NULL);
        }
        if (access) CFRelease(access);
        if (apps) CFRelease(apps);
        if (app) CFRelease(app);
    } else if (delete_op && status == errSecSuccess) {
        status = SecKeychainItemDelete(item);
    }
    explicit_bzero(value, sizeof(value));
    if (data) { explicit_bzero(data, length); SecKeychainItemFreeContent(NULL, data); }
    if (item) CFRelease(item);
    return result(status);
}
