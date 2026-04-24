import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LoginScreen } from './components/Login/LoginScreen';
import { IDELayout } from './components/Layout/IDELayout';
import { UpdateDialog } from './components/UpdateDialog/UpdateDialog';
import { Spinner } from './components/ui/Spinner';

function Root() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="stack" style={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <>
      {status === 'authenticated' ? <IDELayout /> : <LoginScreen />}
      <UpdateDialog />
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}
