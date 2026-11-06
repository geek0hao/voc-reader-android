package cn.voc.reader;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 原生能力桥：
 *  - saveFile(base64 -> 手机「下载/VOCMonitor/日期/」)
 *  - keepAwake(屏幕常亮，比网页 WakeLock 可靠)
 *  - info(版本信息)
 */
@CapacitorPlugin(name = "NativeBridge")
public class NativeBridgePlugin extends Plugin {

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

        String dateFolder = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String savedPath;
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
            call.reject("保存失败: " + e.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        ret.put("path", savedPath);
        ret.put("bytes", bytes.length);
        call.resolve(ret);
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
