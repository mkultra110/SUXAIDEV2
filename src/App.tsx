import { AuthProvider, useAuth } from './contexts/AuthContext';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import { ToastProvider } from './components/ui/Toast';
import { LoginScreen } from './components/Login/LoginScreen';
import { IDELayout } from './components/Layout/IDELayout';
import { UpdateDialog, WhatsNewDialog } from './components/UpdateDialog/UpdateDialog';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { SettingsDialog } from './components/Settings/SettingsDialog';
import { QuickOpen } from './components/QuickOpen/QuickOpen';
import { Spinner } from './components/ui/Spinner';

function Root() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div
        className="stack"
        style={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}
      >
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <>
      {status === 'authenticated' ? <IDELayout /> : <LoginScreen />}
      <UpdateDialog />
      <WhatsNewDialog />
      <CommandPalette />
      <SettingsDialog />
      <QuickOpen />
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <WorkspaceProvider>
          <Root />
        </WorkspaceProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
