import toast, { Toaster, ToastBar } from 'react-hot-toast'
import '../style/notification.css'

/** 每个 WebView 共享一个通知宿主，独立于懒加载页面和连接状态。 */
const NotificationHost = () => (
  <Toaster
    position="top-center"
    containerStyle={{ top: 20, left: 16, right: 16 }}
    toastOptions={{
      duration: 4000,
      style: { maxWidth: 'min(520px, calc(100vw - 32px))' },
      error: { duration: 6000 }
    }}
  >
    {item => (
      <ToastBar toast={item}>
        {({ icon, message }) => (
          <>
            {icon}
            <div className="notification-content">
              {message}
              {item.details && (
                <details className="notification-details">
                  <summary>查看详情</summary>
                  <pre>{Array.isArray(item.details) ? item.details.join('\n') : item.details}</pre>
                </details>
              )}
            </div>
            {item.type !== 'loading' && (
              <button
                className="notification-close"
                type="button"
                aria-label="关闭提示"
                onClick={() => toast.dismiss(item.id)}
              >
                ×
              </button>
            )}
          </>
        )}
      </ToastBar>
    )}
  </Toaster>
)

export default NotificationHost
