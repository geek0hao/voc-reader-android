package cn.voc.reader;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 原生能力桥：
 *  - saveFile(base64 -> 手机「下载/VOCMonitor/日期/」)
 *  - keepAwake(屏幕常亮，比网页 WakeLock 可靠)
 *  - info(版本信息)
 */
@CapacitorPlugin(name = "NativeBridge")
public class NativeBridgePlugin extends Plugin {

    /** 单次过桥允许的最大字节数；更大的文件交由 zipFolder 在原生侧流式处理 */
    private static final int MAX_SINGLE_BYTES = 12 * 1024 * 1024;
    /** 归档包里附加文件（表格/趋势图）的总量上限 */
    private static final long MAX_EXTRAS_BYTES = 8 * 1024 * 1024;

    @PluginMethod
    public void saveFile(PluginCall call) {
        String b64 = call.getString("data");
        if (b64 == null || b64.isEmpty()) {
            call.reject("data 为空");
            return;
        }
        if (b64.startsWith("data:")) {
            int comma = b64.indexOf(',');
            if (comma > 0) b64 = b64.substring(comma + 1);
        }

        String name = sanitize(call.getString("name", "file.bin"));
        String mime = call.getString("mime", "application/octet-stream");
        String folder = sanitize(call.getString("folder", "VOCMonitor"));

        byte[] bytes;
        try {
            bytes = Base64.decode(b64, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("base64 解码失败: " + e.getMessage());
            return;
        }
        // 大包过桥必闪退（JS 侧 base64 + 这里解码各占一份内存），直接拒掉更快也更安全
        if (bytes.length > MAX_SINGLE_BYTES) {
            call.reject("单个文件超过 " + (MAX_SINGLE_BYTES / 1048576) + "MB，已拒绝写入");
            return;
        }

        String dateFolder = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String savedPath;
        Uri pendingUri = null;      // 写失败要删掉，否则留下 IS_PENDING 的“幽灵文件”，文件管理里看不见却占空间
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                String relDir = Environment.DIRECTORY_DOWNLOADS + "/" + folder + "/" + dateFolder;
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, relDir);
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);

                ContentResolver cr = getContext().getContentResolver();
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) {
                    call.reject("系统拒绝创建文件（下载目录不可写）");
                    return;
                }
                pendingUri = uri;
                OutputStream os = cr.openOutputStream(uri);
                if (os == null) {
                    call.reject("无法打开输出流");
                    return;
                }
                try {
                    os.write(bytes);
                    os.flush();
                } finally {
                    os.close();
                }
                cv.clear();
                cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, cv, null, null);
                pendingUri = null;
                savedPath = relDir + "/" + name;
            } else {
                File dir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        folder + "/" + dateFolder);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建目录: " + dir.getAbsolutePath());
                    return;
                }
                File f = new File(dir, name);
                FileOutputStream fos = new FileOutputStream(f);
                try {
                    fos.write(bytes);
                    fos.flush();
                } finally {
                    fos.close();
                }
                savedPath = f.getAbsolutePath();
            }
        } catch (Exception e) {
            if (pendingUri != null) {
                try { getContext().getContentResolver().delete(pendingUri, null, null); } catch (Exception ignored) {}
            }
            call.reject("保存失败: " + e.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        ret.put("path", savedPath);
        ret.put("bytes", bytes.length);
        call.resolve(ret);
    }

    /**
     * 把手机上已保存的照片打包成一个 zip。
     * 全部在原生侧流式读写，JS 一行数据都不用碰——这是修复「打包几千张图就闪退」的关键。
     * 参数：folder（默认 VOCMonitor）、date（yyyy-MM-dd，空表示全部日期）、name（zip 文件名）
     * 返回：{ name, path, count, bytes }
     */
    @PluginMethod
    public void zipFolder(PluginCall call) {
        zipImpl(call, false);
    }

    /**
     * 一键归档包：照片 + 附加文件（csv / xlsx / png）打进同一个 zip。
     * 照片仍然流式读，附加文件只有几百 KB，直接写进 entry，
     * 所以整包再大也不会在 JS 侧爆内存。
     * 参数在 zipFolder 基础上多了 extras: [{ name, data(dataURL或裸base64) }]
     */
    @PluginMethod
    public void archive(PluginCall call) {
        zipImpl(call, true);
    }

    private void zipImpl(PluginCall call, boolean withExtras) {
        String folder = sanitize(call.getString("folder", "VOCMonitor"));
        String date = call.getString("date", "");
        if (date == null) date = "";
        date = date.trim().replaceAll("[^0-9-]", "");   // 只允许 yyyy-MM-dd
        String name = sanitize(call.getString("name", "读数归档.zip"));
        if (!name.toLowerCase(Locale.US).endsWith(".zip")) name = name + ".zip";

        /* 附加文件先解出来（体积很小，几百 KB 级别），解析失败直接报错而不是静默丢文件 */
        List<String> exNames = new ArrayList<>();
        List<byte[]> exBytes = new ArrayList<>();
        long exTotal = 0;
        if (withExtras) {
            JSArray arr = call.getArray("extras");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = null;
                    try { o = arr.getJSONObject(i); } catch (Exception ignored) { }
                    if (o == null) continue;
                    String en = sanitize(o.optString("name", "file" + i));
                    String d = o.optString("data", "");
                    if (d.startsWith("data:")) {
                        int c = d.indexOf(',');
                        if (c > 0) d = d.substring(c + 1);
                    }
                    byte[] b;
                    try {
                        b = Base64.decode(d, Base64.DEFAULT);
                    } catch (Exception e) {
                        call.reject("附加文件解码失败: " + en);
                        return;
                    }
                    if (b.length > MAX_SINGLE_BYTES || exTotal + b.length > MAX_EXTRAS_BYTES) {
                        call.reject("附加文件过大，已取消归档（表格+趋势图应在 8MB 以内）");
                        return;
                    }
                    exTotal += b.length;
                    exNames.add(en);
                    exBytes.add(b);
                }
            }
        }

        String baseRel = Environment.DIRECTORY_DOWNLOADS + "/" + folder;
        String relDir = date.isEmpty() ? baseRel : baseRel + "/" + date;
        ContentResolver cr = getContext().getContentResolver();

        // Android 9 及以下没有 MediaStore.Downloads，退回直接操作文件
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            zipLegacy(call, folder, date, name, baseRel, exNames, exBytes);
            return;
        }

        long totalBytes = 0;
        int count = 0;
        Uri outUri = null;
        ZipOutputStream zos = null;

        try {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, baseRel);
            cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
            outUri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (outUri == null) {
                call.reject("系统拒绝创建压缩包（下载目录不可写）");
                return;
            }

            String[] proj = {
                    MediaStore.MediaColumns._ID,
                    MediaStore.MediaColumns.DISPLAY_NAME,
                    MediaStore.MediaColumns.SIZE,
                    MediaStore.MediaColumns.RELATIVE_PATH,
            };
            String sel = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND "
                    + MediaStore.MediaColumns.MIME_TYPE + " LIKE ?";
            String[] args = {relDir + "%", "image/%"};

            List<Uri> uris = new ArrayList<>();
            List<String> names = new ArrayList<>();
            try (Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, proj, sel, args,
                    MediaStore.MediaColumns.DISPLAY_NAME + " ASC")) {
                while (c != null && c.moveToNext()) {
                    long id = c.getLong(0);
                    String dn = c.getString(1);
                    String rp = c.getString(3);
                    if (dn == null) continue;
                    // 按日期分子目录时，把日期前缀带上，避免同名覆盖
                    String entry = dn;
                    if (date.isEmpty() && rp != null && rp.length() > baseRel.length() + 1) {
                        String sub = rp.substring(baseRel.length()).replace("/", "");
                        if (!sub.isEmpty()) entry = sub + "_" + dn;
                    }
                    if (withExtras) entry = "照片/" + entry;   // 归档包里把照片单独归一个目录
                    uris.add(ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id));
                    names.add(entry);
                }
            }

            if (uris.isEmpty() && exBytes.isEmpty()) {
                cr.delete(outUri, null, null);
                call.reject(date.isEmpty() ? "手机里还没有已保存的照片" : (date + " 没有已保存的照片"));
                return;
            }

            OutputStream os = cr.openOutputStream(outUri);
            if (os == null) {
                cr.delete(outUri, null, null);
                call.reject("无法打开压缩包输出流");
                return;
            }
            zos = new ZipOutputStream(new BufferedOutputStream(os));
            byte[] buf = new byte[64 * 1024];
            for (int i = 0; i < uris.size(); i++) {
                InputStream in = null;
                try {
                    in = cr.openInputStream(uris.get(i));
                    if (in == null) continue;
                    zos.putNextEntry(new ZipEntry(names.get(i)));
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        zos.write(buf, 0, n);
                        totalBytes += n;
                    }
                    zos.closeEntry();
                    count++;
                } catch (Exception one) {
                    // 单张读失败不影响整体，跳过继续
                } finally {
                    if (in != null) try { in.close(); } catch (Exception ignored) {}
                }
            }
            // 附加文件（表格、趋势图）直接写进同一个 zip
            for (int i = 0; i < exNames.size(); i++) {
                zos.putNextEntry(new ZipEntry(exNames.get(i)));
                zos.write(exBytes.get(i));
                zos.closeEntry();
            }
            zos.finish();
            zos.close();
            zos = null;

            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(outUri, done, null, null);

            JSObject ret = new JSObject();
            ret.put("name", name);
            ret.put("path", baseRel + "/" + name);
            ret.put("count", count);
            ret.put("extras", exBytes.size());
            ret.put("bytes", totalBytes + exTotal);
            call.resolve(ret);
        } catch (Exception e) {
            try { if (zos != null) zos.close(); } catch (Exception ignored) {}
            if (outUri != null) try { cr.delete(outUri, null, null); } catch (Exception ignored) {}
            call.reject("打包失败: " + e.getMessage());
        }
    }

    /** Android 9 及以下的打包实现：直接读文件目录，同样流式写，不占内存 */
    private void zipLegacy(PluginCall call, String folder, String date, String name, String baseRel,
                           List<String> exNames, List<byte[]> exBytes) {
        File base = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), folder);
        File dir = date.isEmpty() ? base : new File(base, date);
        File[] list = dir.listFiles((d, n) -> n.toLowerCase(Locale.US).endsWith(".jpg"));
        if (list == null) list = new File[0];
        if (list.length == 0 && exBytes.isEmpty()) {
            call.reject(date.isEmpty() ? "手机里还没有已保存的照片" : (date + " 没有已保存的照片"));
            return;
        }
        // 按文件名排序，保证压缩包内顺序与采集顺序一致
        final boolean nest = !exBytes.isEmpty();
        java.util.Arrays.sort(list, (a, b) -> a.getName().compareTo(b.getName()));
        File out = new File(base, name);
        long totalBytes = 0;
        int count = 0;
        try (ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(out)))) {
            byte[] buf = new byte[64 * 1024];
            for (File f : list) {
                try (InputStream in = new java.io.FileInputStream(f)) {
                    zos.putNextEntry(new ZipEntry((nest ? "照片/" : "") + f.getName()));
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        zos.write(buf, 0, n);
                        totalBytes += n;
                    }
                    zos.closeEntry();
                    count++;
                } catch (Exception one) {
                    // 单张失败跳过
                }
            }
            long exTotal = 0;
            for (int i = 0; i < exNames.size(); i++) {
                zos.putNextEntry(new ZipEntry(exNames.get(i)));
                zos.write(exBytes.get(i));
                zos.closeEntry();
                exTotal += exBytes.get(i).length;
            }
            zos.finish();
            JSObject ret = new JSObject();
            ret.put("name", name);
            ret.put("path", out.getAbsolutePath());
            ret.put("count", count);
            ret.put("extras", exBytes.size());
            ret.put("bytes", totalBytes + exTotal);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("打包失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        Boolean on = call.getBoolean("on", Boolean.TRUE);
        final boolean enable = on == null || on;
        if (getActivity() == null) {
            call.reject("activity 不存在");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (enable) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject o = new JSObject();
        // AGP 8 默认不生成 BuildConfig，这里直接问系统要版本号
        String version = "1.0";
        try {
            version = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        o.put("version", version);
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(o);
    }

    /** 去掉路径分隔符等危险字符，避免写出目录之外 */
    private String sanitize(String s) {
        if (s == null || s.trim().isEmpty()) return "file";
        return s.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
    }
}
