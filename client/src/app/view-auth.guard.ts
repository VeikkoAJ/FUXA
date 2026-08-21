import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { Injectable } from '@angular/core';
import { AuthService } from './_services/auth.service';
import { ProjectService } from './_services/project.service';
import { ToastrService } from 'ngx-toastr';
import { TranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { LoginComponent } from './login/login.component';
import { MatDialog as MatDialog } from '@angular/material/dialog';

/**
 * Guards the runtime view routes (home/view/ar) when the project requires
 * every viewer to sign in (secureEnabled === true and secureOnlyEditor === false).
 * Unlike AuthGuard, it only requires an authenticated user, not an admin.
 */
@Injectable()
export class ViewAuthGuard {
    constructor(private authService: AuthService,
        private translateService: TranslateService,
        private toastr: ToastrService,
        private projectService: ProjectService,
        private dialog: MatDialog) {
    }

    canActivate(next: ActivatedRouteSnapshot, state: RouterStateSnapshot): Observable<boolean> {
        return this.projectService.checkServer().pipe(
            switchMap((response) => {
                if (!response?.secureEnabled || response?.secureOnlyEditor) {
                    return of(true);
                }
                if (this.authService.isAuthenticated()) {
                    return of(true);
                }
                const dialogRef = this.dialog.open(LoginComponent, { disableClose: true });
                return dialogRef.afterClosed().pipe(
                    map(() => {
                        if (this.authService.isAuthenticated()) {
                            return true;
                        }
                        this.notifySaveError('msg.signin-unauthorized');
                        return false;
                    })
                );
            })
        );
    }

    private notifySaveError(textKey: string) {
        let msg = '';
        this.translateService.get(textKey).subscribe((txt: string) => { msg = txt; });
        this.toastr.error(msg, '', {
            timeOut: 3000,
            closeButton: true,
            disableTimeOut: true
        });
    }
}
